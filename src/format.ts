import { prettifyMarkdownContent } from "@jacobbubu/md-zh-format";

export async function formatTranslatedMarkdown(markdown: string, filePathHint: string): Promise<string> {
  const result = await prettifyMarkdownContent(markdown, filePathHint, {
    preserveFrontmatter: true,
    promoteHeadings: false
  });
  return result.prettifiedContent;
}

export async function formatTranslatedBody(body: string, filePathHint: string): Promise<string> {
  const result = await prettifyMarkdownContent(body, filePathHint, {
    preserveFrontmatter: false,
    promoteHeadings: false
  });
  return result.prettifiedContent;
}

export function reconstructMarkdown(frontmatter: string | null, body: string): string {
  if (!frontmatter) {
    return body;
  }

  const normalizedBody = body.replace(/^\n+/, "");
  const joiner = frontmatter.endsWith("\n\n") ? "" : "\n";
  return `${frontmatter}${joiner}${normalizedBody}`;
}
