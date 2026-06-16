import { getMyNotifications, type AppNotification } from "@/app/actions/notifications";
import { NotificationsList } from "./_components/notifications-list";

export default async function NotificacoesPage() {
  let notifications: AppNotification[] = [];

  try {
    notifications = await getMyNotifications();
  } catch {
    // Continua sem notificações — não crasha a página
  }

  return (
    <div className="flex flex-col gap-4 pb-2">
      <h1 className="text-xl font-bold text-[var(--color-text-main)]">Notificações</h1>
      <NotificationsList initial={notifications} />
    </div>
  );
}
