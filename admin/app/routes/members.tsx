import { FormEvent, useEffect, useState } from 'react';
import { KeyRound, UserPlus, UserX } from 'lucide-react';
import { api } from '../api';
import { useDialogs } from '@/components/dialogs';
import { Field, Notices, Page, PageHeader, Section, TableCard } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Member {
  id: string;
  username: string;
  role: string;
  disabledAt: string | null;
  createdAt: string;
}

export function Members() {
  const [items, setItems] = useState<Member[]>([]);
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { confirm, askPassword } = useDialogs();

  const load = () => api<Member[]>('/members').then(setItems).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      await api('/members', { method: 'POST', body: JSON.stringify(form) });
      setForm({ username: '', password: '' });
      setNotice('Đã thêm nhân viên.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi thêm thành viên');
    }
  };

  const changePassword = async (member: Member) => {
    const password = await askPassword({
      title: `Đổi mật khẩu ${member.username}`,
      description: 'Các phiên đăng nhập cũ của tài khoản này sẽ bị đăng xuất.',
    });
    if (!password) return;
    setError('');
    setNotice('');
    try {
      await api(`/members/${member.id}/password`, { method: 'PATCH', body: JSON.stringify({ password }) });
      setNotice(`Đã đổi mật khẩu ${member.username} và đăng xuất các phiên cũ.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi đổi mật khẩu');
    }
  };

  const disable = async (member: Member) => {
    const ok = await confirm({
      title: `Vô hiệu hoá ${member.username}?`,
      description: 'Tài khoản này sẽ không đăng nhập được nữa.',
      confirmLabel: 'Vô hiệu hoá',
      destructive: true,
    });
    if (!ok) return;
    setError('');
    setNotice('');
    try {
      await api(`/members/${member.id}`, { method: 'DELETE' });
      setNotice(`Đã vô hiệu hoá ${member.username}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi vô hiệu hoá');
    }
  };

  return (
    <Page>
      <PageHeader
        title="Thành viên"
        description="Nhân viên (agent) xem hội thoại, tiếp quản và trả lời khách; không sửa được bot, kênh hay thành viên."
      />
      <Notices error={error} notice={notice} />

      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tên đăng nhập</TableHead>
              <TableHead>Vai trò</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Ngày tạo</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-medium">{m.username}</TableCell>
                <TableCell>{m.role === 'owner' ? 'Chủ shop' : 'Nhân viên'}</TableCell>
                <TableCell>
                  {m.disabledAt ? (
                    <Badge variant="destructive">Đã vô hiệu hoá</Badge>
                  ) : (
                    <Badge variant="secondary" className="bg-success/10 text-success">
                      Hoạt động
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{new Date(m.createdAt).toLocaleDateString('vi-VN')}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => changePassword(m)}>
                      <KeyRound />
                      Đổi mật khẩu
                    </Button>
                    {!m.disabledAt && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => disable(m)}
                      >
                        <UserX />
                        Vô hiệu hoá
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!items.length && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  Chưa có thành viên.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableCard>

      <Section title="Thêm nhân viên">
        <Card className="py-5">
          <CardContent>
            <form className="grid items-end gap-4 sm:grid-cols-[1fr_1fr_auto]" onSubmit={submit}>
              <Field label="Tên đăng nhập" htmlFor="m-username">
                <Input
                  id="m-username"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  required
                  minLength={3}
                  maxLength={32}
                  pattern="[a-zA-Z0-9._\-]+"
                  title="3-32 ký tự: chữ, số, dấu chấm, gạch dưới, gạch ngang"
                  autoComplete="off"
                />
              </Field>
              <Field label="Mật khẩu" htmlFor="m-password">
                <Input
                  id="m-password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  type="password"
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
              </Field>
              <Button type="submit">
                <UserPlus />
                Thêm nhân viên
              </Button>
            </form>
          </CardContent>
        </Card>
      </Section>
    </Page>
  );
}
