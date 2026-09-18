import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { RuntimeEnvironmentPresentation } from "../components/auth/RuntimeEnvironmentPresentation";
import { parseRuntimeDisplayEnvironment } from "../domain/institution";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    template: "%s · Capstone Impact Platform",
    default: "Capstone Impact Platform",
  },
  description:
    "Administrative system for collecting, reviewing, and preparing RMIT capstone projects for publication.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <RuntimeEnvironmentPresentation environment={parseRuntimeDisplayEnvironment(process.env.CAPSTONE_RUNTIME_ENV)}>
          {children}
        </RuntimeEnvironmentPresentation>
      </body>
    </html>
  );
}
