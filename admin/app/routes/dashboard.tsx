import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, MessagesSquare, UserRound } from 'lucide-react';
import { api } from '../api';
import { LoadError, Loading, Page, PageHeader } from '@/components/page';
import { Card, CardContent } from '@/components/ui/card';

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

  if (error) return <LoadError message={error} />;
  if (!stats) return <Loading />;

  const cards = [
    { label: 'Hội thoại', value: stats.conversations, icon: MessagesSquare },
    { label: 'Đang người thật', value: stats.humanMode, icon: UserRound },
    { label: 'Tin khách hôm nay', value: stats.inboundToday, icon: ArrowDownLeft },
    { label: 'Tin gửi hôm nay', value: stats.outboundToday, icon: ArrowUpRight },
  ];
  return (
    <Page>
      <PageHeader title="Dashboard" description="Tổng quan hoạt động của workspace." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(({ label, value, icon: Icon }) => (
          <Card key={label} className="gap-0 py-5">
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">{label}</span>
                <span className="grid size-8 place-items-center rounded-md bg-accent text-accent-foreground">
                  <Icon className="size-4" />
                </span>
              </div>
              <div className="text-3xl font-semibold tracking-tight tabular-nums">{value.toLocaleString('vi-VN')}</div>
            </CardContent>
          </Card>
        ))}
      </div>
    </Page>
  );
}
