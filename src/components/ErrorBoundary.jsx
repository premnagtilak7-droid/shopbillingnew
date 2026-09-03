import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('BillFlow runtime error:', error, errorInfo)
  }

  reset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <main className="error-shell">
        <section className="error-card" role="alert">
          <div className="brand-mark">B</div>
          <p className="eyebrow">BILLFLOW RECOVERY</p>
          <h1>Something went wrong</h1>
          <p className="muted">The screen recovered from an unexpected error. Your saved data is safe.</p>
          {this.state.error?.message && <small className="error-details">{this.state.error.message}</small>}
          <div className="error-actions">
            <button className="primary-btn" onClick={this.reset}>Try again</button>
            <button className="secondary-btn" onClick={() => window.location.reload()}>Reload page</button>
          </div>
        </section>
      </main>
    )
  }
}
