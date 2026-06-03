import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://ceqzxgizhgmvcniapyla.supabase.co",
  "sb_secret_9M-aY1NUXLUIT-vJAXiseA_lbpVrznK",
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const { data, error } = await supabase.auth.admin.updateUserById(
  "03def8bb-f7ae-4963-9a7d-78292b867d73",
  { password: "Escala2026!" }
);

if (error) {
  console.error("❌ Erro:", error.message);
} else {
  console.log("✅ Password redefinida com sucesso!");
  console.log("   Email:", data.user.email);
  console.log("   Nova password: Escala2026!");
}
