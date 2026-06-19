"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";

export function SidebarNotifBadge() {
  const [count, setCount] = useState(0);
  const [supabase] = useState(() => createClient());

  const load = useCallback(async () => {
    const { count: n } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null);
    setCount(n ?? 0);
  }, [supabase]);

  useEffect(() => {
    const channel = supabase
      .channel("sidebar-notif-count")
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, load)
      .subscribe();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => { supabase.removeChannel(channel); };
  }, [load, supabase]);

  if (count === 0) return null;

  return (
    <span className="ml-auto min-w-[18px] h-[18px] px-1 bg-red-500 rounded-full text-white text-[9px] font-bold flex items-center justify-center leading-none">
      {count > 99 ? "99+" : count}
    </span>
  );
}
