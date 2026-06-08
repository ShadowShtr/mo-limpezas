import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getManagementTasks } from "@/app/actions/management-tasks";
import { TasksClient } from "./_components/tasks-client";

export default async function TarefasPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: profile } = await admin.from("profiles").select("company_id").eq("id", user.id).single();
  if (!profile?.company_id) redirect("/login");

  const [tasksRes, { data: members }] = await Promise.all([
    getManagementTasks(profile.company_id),
    admin
      .from("profiles")
      .select("id, full_name")
      .eq("company_id", profile.company_id)
      .eq("status", "ativo")
      .order("full_name"),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold text-[var(--color-text-main)]">Tarefas de Gestão</h1>
        <p className="text-sm text-[var(--color-text-muted)] mt-0.5">Notas e tarefas entre gestores</p>
      </div>

      <TasksClient
        initialTasks={tasksRes.ok ? tasksRes.tasks : []}
        companyId={profile.company_id}
        members={(members ?? []).map((m) => ({ id: m.id, full_name: m.full_name }))}
      />
    </div>
  );
}
