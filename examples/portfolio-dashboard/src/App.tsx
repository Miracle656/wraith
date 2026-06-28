import { useState, useEffect, FormEvent } from 'react';
import './index.css';

// Using Vite env vars if available, fallback to localhost
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

interface TokenSummary {
  contractId: string;
  displayTotalReceived: string;
  displayTotalSent: string;
  displayNetFlow: string;
  txCount: number;
}

interface SummaryResponse {
  address: string;
  tokens: TokenSummary[];
}

interface Transfer {
  id: number;
  contractId: string;
  eventType: string;
  fromAddress: string;
  toAddress: string;
  displayAmount: string;
  ledgerClosedAt: string;
  txHash: string;
  direction: 'incoming' | 'outgoing';
}

interface TransfersResponse {
  total: number;
  transfers: Transfer[];
}

function App() {
  const [address, setAddress] = useState('GABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [transfers, setTransfers] = useState<TransfersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async (targetAddress: string) => {
    if (!targetAddress) return;
    setLoading(true);
    setError(null);
    try {
      const [summaryRes, transfersRes] = await Promise.all([
        fetch(`${API_URL}/summary/${targetAddress}`),
        fetch(`${API_URL}/transfers/address/${targetAddress}?limit=10`)
      ]);

      if (!summaryRes.ok) throw new Error('Failed to fetch summary');
      if (!transfersRes.ok) throw new Error('Failed to fetch transfers');

      const summaryData = await summaryRes.json();
      const transfersData = await transfersRes.json();

      setSummary(summaryData);
      setTransfers(transfersData);
    } catch (err: any) {
      setError(err.message || 'An error occurred while fetching data.');
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e: FormEvent) => {
    e.preventDefault();
    fetchData(address);
  };

  useEffect(() => {
    // Optionally fetch initial data
    // fetchData(address);
  }, []);

  return (
    <div className="dashboard-container">
      <header className="glass-header">
        <h1>Wraith Portfolio</h1>
        <form onSubmit={handleSearch} className="search-form">
          <input 
            type="text" 
            value={address} 
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Enter Stellar Address (G...)"
            required
            pattern="^G[A-Z0-9]{55}$"
            title="Valid Stellar public key starting with G"
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Searching...' : 'Search'}
          </button>
        </form>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {!loading && !error && summary && (
        <main className="dashboard-content">
          <section className="holdings-section animate-in">
            <h2>Current Holdings</h2>
            {summary.tokens.length === 0 ? (
              <p className="empty-state">No tokens held by this address.</p>
            ) : (
              <div className="cards-grid">
                {summary.tokens.map((token) => (
                  <div key={token.contractId} className="holding-card glass-card">
                    <div className="card-header">
                      <span className="token-id">{token.contractId.slice(0, 4)}...{token.contractId.slice(-4)}</span>
                    </div>
                    <div className="balance-display">
                      <span className="balance-amount">{token.displayNetFlow}</span>
                      <span className="balance-label">Net Balance</span>
                    </div>
                    <div className="stats-row">
                      <div className="stat">
                        <span className="stat-value text-green">+{token.displayTotalReceived}</span>
                        <span className="stat-label">Received</span>
                      </div>
                      <div className="stat">
                        <span className="stat-value text-red">-{token.displayTotalSent}</span>
                        <span className="stat-label">Sent</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="transfers-section animate-in delay-1">
            <h2>Recent Transfers</h2>
            {transfers?.transfers.length === 0 ? (
              <p className="empty-state">No recent transfers.</p>
            ) : (
              <div className="table-wrapper glass-card">
                <table className="transfers-table">
                  <thead>
                    <tr>
                      <th>Direction</th>
                      <th>Token</th>
                      <th>Amount</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transfers?.transfers.map((tx) => (
                      <tr key={tx.id} className="table-row">
                        <td>
                          <span className={`badge ${tx.direction}`}>
                            {tx.direction === 'incoming' ? '↓ IN' : '↑ OUT'}
                          </span>
                        </td>
                        <td className="mono">{tx.contractId.slice(0, 4)}...{tx.contractId.slice(-4)}</td>
                        <td className="mono font-bold">
                          {tx.direction === 'incoming' ? '+' : '-'}{tx.displayAmount}
                        </td>
                        <td className="date-cell">
                          {new Date(tx.ledgerClosedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

export default App;
