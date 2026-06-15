import { redirect } from "next/navigation";
import { AppHeader } from "@/components/layout/app-header";
import { BottomNav } from "@/components/layout/bottom-nav";
import { PwaRegister } from "./_components/pwa-register";
import { getCurrentProfile } from "@/lib/auth/current-user";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await getCurrentProfile();

  if (!profile) redirect("/login");
  if (profile.role !== "colaborador") redirect("/dashboard");

  return (
    <div className="flex flex-col min-h-screen">
      <PwaRegister />
      <AppHeader userId={profile.id} userName={profile.full_name} avatarUrl={profile.avatar_url} />
      <main className="flex-1 overflow-y-auto pb-20 px-4 pt-4">
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
