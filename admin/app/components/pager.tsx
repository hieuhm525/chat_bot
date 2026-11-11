import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Prev/next pager for offset-paginated lists: "Trang 2/5 · 87 kết quả". */
export function Pager(props: { page: number; pageSize: number; total: number; onPage: (page: number) => void; disabled?: boolean }) {
  const pages = Math.max(1, Math.ceil(props.total / props.pageSize));
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
      <span className="tabular-nums">
        Trang {props.page}/{pages} · {props.total} kết quả
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => props.onPage(props.page - 1)}
          disabled={props.disabled || props.page <= 1}
        >
          <ChevronLeft />
          Trước
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => props.onPage(props.page + 1)}
          disabled={props.disabled || props.page >= pages}
        >
          Sau
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
