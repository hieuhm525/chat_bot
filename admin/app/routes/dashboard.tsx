import { useEffect, useState } from 'react';
import { api } from '../api';

interface Summary {
  conversations: number;
  humanMode: number;
  inboundToday: number;
  outboundToday: number;
}

export function Dashboard() {
  const [stats, setStats] = useState<Summary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Summary>('/stats/summary').then(setStats).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="error pad">{error}</p>;
  if (!stats) return <p className="muted pad">Đang tải…</p>;

  const cards = [
    ['Hội thoại', stats.conversations],
    ['Đang người thật', stats.humanMode],
    ['Tin khách hôm nay', stats.inboundToday],
    ['Tin gửi hôm nay', stats.outboundToday],
  ];
  return (
    <div className="pad">
      <h1>Dashboard</h1>
      <div className="cards">
        {cards.map(([label, value]) => (
          <div className="card stat" key={label}>
            <div className="value">{value}</div>
            <div className="muted">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
