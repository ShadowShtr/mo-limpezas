import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { cn } from "@/lib/utils";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Escala",
  description: "Plataforma de gestão operacional para equipas de limpeza",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt" className={cn("h-full", inter.variable, "font-sans")}>
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
