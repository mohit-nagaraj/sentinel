import type { Metadata } from "next";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import { Footer, Layout, Navbar } from "nextra-theme-docs";
import "nextra-theme-docs/style.css";
import type { ReactNode } from "react";
import { CommandSearch } from "./command-search";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Sentinel",
    template: "%s | Sentinel",
  },
  description: "Sentinel project documentation",
};

const navbar = <Navbar logo={<strong>Sentinel</strong>} />;
const footer = <Footer>Sentinel</Footer>;

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head>
        <meta name="theme-color" content="#ffffff" />
      </Head>
      <body>
        <Layout
          navbar={navbar}
          footer={footer}
          search={<CommandSearch />}
          pageMap={await getPageMap()}
          docsRepositoryBase="https://github.com/mohit-nagaraj/sentinel/tree/main/docs"
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
