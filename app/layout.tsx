import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jammer",
  description:
    "Jam along with your favourite songs — tab, chords and lyrics synced to the actual recording you're streaming.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
