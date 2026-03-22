import { prettifyMarkdownContent } from "@jacobbubu/md-zh-format";

export async function formatTranslatedMarkdown(markdown: string, filePathHint: string): Promise<string> {
  const result = await prettifyMarkdownContent(markdown, filePathHint, {
    preserveFrontmatter: true,
    promoteHeadings: false
  });
  return result.prettifiedContent;
}
