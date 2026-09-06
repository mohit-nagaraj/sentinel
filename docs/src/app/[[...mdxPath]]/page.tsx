import { generateStaticParamsFor, importPage } from "nextra/pages";
import { useMDXComponents as getMDXComponents } from "../../../mdx-components";

export const generateStaticParams = generateStaticParamsFor("mdxPath");

export async function generateMetadata({
  params,
}: {
  params: Promise<{ mdxPath?: string[] }>;
}) {
  const { mdxPath } = await params;
  const { metadata } = await importPage(mdxPath);
  return metadata;
}

const Wrapper = getMDXComponents({}).wrapper!;

export default async function Page({
  params,
}: {
  params: Promise<{ mdxPath?: string[] }>;
}) {
  const resolvedParams = await params;
  const { default: MDXContent, toc, metadata, sourceCode } = await importPage(
    resolvedParams.mdxPath,
  );

  return (
    <Wrapper toc={toc} metadata={metadata} sourceCode={sourceCode}>
      <MDXContent params={resolvedParams} />
    </Wrapper>
  );
}
