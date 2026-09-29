-- BillFlow Step 11: atomic POS checkout.
-- Apply this migration to prevent payment/invoice records from being saved when stock cannot be deducted.

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

UPDATE public.invoice_items AS item
SET workspace_id = invoice.workspace_id
FROM public.invoices AS invoice
WHERE item.invoice_id = invoice.id
  AND item.workspace_id IS NULL;

CREATE INDEX IF NOT EXISTS invoice_items_workspace_id_idx
  ON public.invoice_items(workspace_id);

CREATE OR REPLACE FUNCTION public.create_pos_sale(
  p_invoice JSONB,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id UUID := NULLIF(p_invoice->>'workspace_id', '')::UUID;
  v_invoice_id UUID;
  v_item JSONB;
  v_product_id UUID;
  v_quantity NUMERIC;
  v_stock NUMERIC;
  v_stock_updates JSONB := '[]'::JSONB;
BEGIN
  IF v_workspace_id IS NULL OR v_workspace_id <> public.current_workspace_id() THEN
    RAISE EXCEPTION 'Invalid workspace for checkout';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND workspace_id = v_workspace_id
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Active staff profile required for checkout';
  END IF;

  -- Lock and validate every tracked product before creating the invoice.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) LOOP
    v_quantity := GREATEST(0, COALESCE((v_item->>'quantity')::NUMERIC, 0));
    v_product_id := NULLIF(v_item->>'product_id', '')::UUID;

    IF v_product_id IS NULL THEN
      SELECT id INTO v_product_id
      FROM public.products
      WHERE workspace_id = v_workspace_id
        AND sku = v_item->>'sku'
      LIMIT 1;
    END IF;

    SELECT stock INTO v_stock
    FROM public.products
    WHERE id = v_product_id
      AND workspace_id = v_workspace_id
    FOR UPDATE;

    IF v_stock IS NOT NULL AND v_stock < v_quantity THEN
      RAISE EXCEPTION 'Insufficient stock for %', COALESCE(v_item->>'name', v_item->>'product_name', 'product');
    END IF;
  END LOOP;

  INSERT INTO public.invoices (
    invoice_number,
    workspace_id,
    customer_name,
    customer_id,
    created_by_staff_id,
    subtotal,
    tax,
    total,
    status,
    payment_method
  ) VALUES (
    p_invoice->>'invoice_number',
    v_workspace_id,
    COALESCE(p_invoice->>'customer_name', 'Walk-in customer'),
    NULLIF(p_invoice->>'customer_id', '')::UUID,
    NULLIF(p_invoice->>'created_by_staff_id', '')::UUID,
    COALESCE((p_invoice->>'subtotal')::NUMERIC, 0),
    COALESCE((p_invoice->>'tax')::NUMERIC, 0),
    COALESCE((p_invoice->>'total')::NUMERIC, 0),
    COALESCE(p_invoice->>'status', 'Paid'),
    COALESCE(p_invoice->>'payment_method', 'Cash')
  )
  RETURNING id INTO v_invoice_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) LOOP
    v_quantity := GREATEST(0, COALESCE((v_item->>'quantity')::NUMERIC, 0));
    v_product_id := NULLIF(v_item->>'product_id', '')::UUID;

    IF v_product_id IS NULL THEN
      SELECT id INTO v_product_id
      FROM public.products
      WHERE workspace_id = v_workspace_id
        AND sku = v_item->>'sku'
      LIMIT 1;
    END IF;

    UPDATE public.products
    SET stock = stock - v_quantity
    WHERE id = v_product_id
      AND workspace_id = v_workspace_id
      AND stock IS NOT NULL;

    INSERT INTO public.invoice_items (
      invoice_id,
      workspace_id,
      product_id,
      product_name,
      quantity,
      unit_price,
      tax_rate,
      line_total
    ) VALUES (
      v_invoice_id,
      v_workspace_id,
      v_product_id,
      COALESCE(v_item->>'name', v_item->>'product_name', 'Item'),
      v_quantity,
      COALESCE((v_item->>'price')::NUMERIC, (v_item->>'unit_price')::NUMERIC, 0),
      COALESCE((v_item->>'tax')::NUMERIC, (v_item->>'tax_rate')::NUMERIC, 0),
      COALESCE((v_item->>'price')::NUMERIC, (v_item->>'unit_price')::NUMERIC, 0) * v_quantity
    );

    SELECT stock INTO v_stock
    FROM public.products
    WHERE id = v_product_id
      AND workspace_id = v_workspace_id;

    v_stock_updates := v_stock_updates || jsonb_build_array(jsonb_build_object(
      'id', v_product_id,
      'sku', v_item->>'sku',
      'stock', v_stock
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'invoice_id', v_invoice_id,
    'invoice_number', p_invoice->>'invoice_number',
    'stock_updates', v_stock_updates
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_pos_sale(JSONB, JSONB)
TO authenticated;
