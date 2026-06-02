import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDistanceToNow(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "agora mesmo";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `há ${days} ${days === 1 ? "dia" : "dias"}`;
  return new Date(dateStr).toLocaleDateString("pt-PT", { day: "numeric", month: "short" });
}

export function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("pt-PT", { weekday: "long", day: "numeric", month: "long" });
}
