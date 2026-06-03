import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "STATIS",
  description: "Tableau de bord temps reel pour l'institution de microfinance.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
