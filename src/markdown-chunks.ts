const MAX_CHUNK_CHARACTERS = 8500;
const TARGET_CHUNK_CHARACTERS = 5200;
const MIN_HEADING_SPLIT_CHARACTERS = TARGET_CHUNK_CHARACTERS;
const MAX_CHUNK_BLOCKS = 16;

type MarkdownBlock = {
  content: string;
  separator: string;
  headingLevel: number | null;
  headingText: string | null;
  headingPath: string[];
};

export type MarkdownChunk = {
  index: number;
  source: string;
  separatorAfter: string;
  headingPath: string[];
};

export type MarkdownChunkPlan = {
  documentTitle: string | null;
  chunks: MarkdownChunk[];
};

export function planMarkdownChunks(body: string): MarkdownChunkPlan {
  const blocks = parseMarkdownBlocks(body);
  if (blocks.length === 0) {
    return {
      documentTitle: null,
      chunks: [
        {
          index: 0,
          source: body,
          separatorAfter: "",
          headingPath: []
        }
      ]
    };
  }

  const documentTitle = blocks.find((block) => block.headingLevel === 1)?.headingText ?? null;
  const sections = coalesceSections(splitIntoSections(blocks));
  const chunkBlocks = sections.flatMap((section) => splitSectionIntoChunks(section));

  return {
    documentTitle,
    chunks: chunkBlocks.map((chunkBlocksForSource, index) => buildChunk(chunkBlocksForSource, index))
  };
}

function buildChunk(blocks: readonly MarkdownBlock[], index: number): MarkdownChunk {
  const lastBlock = blocks.at(-1);
  if (!lastBlock) {
    return {
      index,
      source: "",
      separatorAfter: "",
      headingPath: []
    };
  }

  const source = blocks
    .map((block, blockIndex) =>
      blockIndex === blocks.length - 1 ? block.content : `${block.content}${block.separator}`
    )
    .join("");

  return {
    index,
    source,
    separatorAfter: lastBlock.separator,
    headingPath: deriveChunkHeadingPath(blocks)
  };
}

function deriveChunkHeadingPath(blocks: readonly MarkdownBlock[]): string[] {
  for (const block of blocks) {
    if (block.headingPath.length > 0) {
      return [...block.headingPath];
    }
  }
  return [];
}

function splitIntoSections(blocks: readonly MarkdownBlock[]): MarkdownBlock[][] {
  const sections: MarkdownBlock[][] = [];
  let current: MarkdownBlock[] = [];

  for (const block of blocks) {
    if (block.headingLevel !== null && block.headingLevel <= 2 && current.length > 0) {
      sections.push(current);
      current = [];
    }
    current.push(block);
  }

  if (current.length > 0) {
    sections.push(current);
  }

  return sections;
}

function coalesceSections(sections: readonly MarkdownBlock[][]): MarkdownBlock[][] {
  if (sections.length <= 1) {
    return sections.map((section) => [...section]);
  }

  const merged: MarkdownBlock[][] = [];
  let current: MarkdownBlock[] = [];
  let currentLength = 0;

  for (const section of sections) {
    const sectionLength = measureBlocks(section);
    const firstHeadingLevel = section[0]?.headingLevel ?? null;
    const currentHasHeading = current.some((block) => block.headingLevel !== null);
    const shouldStartFresh =
      current.length === 0 ||
      (firstHeadingLevel === 1 && currentHasHeading) ||
      currentLength >= TARGET_CHUNK_CHARACTERS ||
      currentLength + sectionLength > MAX_CHUNK_CHARACTERS;

    if (shouldStartFresh) {
      if (current.length > 0) {
        merged.push(current);
      }
      current = [...section];
      currentLength = sectionLength;
      continue;
    }

    current.push(...section);
    currentLength += sectionLength;
  }

  if (current.length > 0) {
    merged.push(current);
  }

  return merged;
}

function splitSectionIntoChunks(section: readonly MarkdownBlock[]): MarkdownBlock[][] {
  if (section.length === 0) {
    return [];
  }

  if (measureBlocks(section) <= MAX_CHUNK_CHARACTERS && section.length <= MAX_CHUNK_BLOCKS) {
    return [[...section]];
  }

  const chunks: MarkdownBlock[][] = [];
  let current: MarkdownBlock[] = [];
  let currentLength = 0;

  for (const block of section) {
    const blockLength = measureBlocks([block]);
    const currentStartsWithHeading = current[0]?.headingLevel !== null;
    const wouldExceedLength =
      current.length > 0 &&
      currentLength + blockLength > MAX_CHUNK_CHARACTERS &&
      !(current.length === 1 && currentStartsWithHeading);
    const wouldExceedBlockCount = current.length >= MAX_CHUNK_BLOCKS;
    const shouldSplitBeforeHeading =
      block.headingLevel !== null &&
      current.length > 0 &&
      currentLength >= MIN_HEADING_SPLIT_CHARACTERS;

    if (wouldExceedLength || wouldExceedBlockCount || shouldSplitBeforeHeading) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }

    current.push(block);
    currentLength += blockLength;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function measureBlocks(blocks: readonly MarkdownBlock[]): number {
  return blocks.reduce((total, block) => total + block.content.length + block.separator.length, 0);
}

function parseMarkdownBlocks(body: string): MarkdownBlock[] {
  const rawBlocks = splitRawBlocks(body);
  const blocks: MarkdownBlock[] = [];
  const headingStack: string[] = [];

  for (const rawBlock of rawBlocks) {
    const heading = parseHeading(rawBlock.content);
    let headingPath = headingStack;

    if (heading) {
      headingStack.length = Math.max(heading.level - 1, 0);
      headingStack[heading.level - 1] = heading.text;
      headingStack.length = heading.level;
      headingPath = [...headingStack];
    } else {
      headingPath = [...headingStack];
    }

    blocks.push({
      ...rawBlock,
      headingLevel: heading?.level ?? null,
      headingText: heading?.text ?? null,
      headingPath
    });
  }

  return blocks;
}

function parseHeading(content: string): { level: number; text: string } | null {
  const trimmed = content.trim();
  if (trimmed.includes("\n")) {
    return null;
  }

  const match = trimmed.match(/^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?$/);
  if (!match) {
    return null;
  }

  return {
    level: match[1]!.length,
    text: match[2]!.trim()
  };
}

function splitRawBlocks(body: string): Array<{ content: string; separator: string }> {
  if (body.length === 0) {
    return [];
  }

  const blocks: Array<{ content: string; separator: string }> = [];
  const pattern = /\n{2,}/g;
  let lastIndex = 0;

  for (const match of body.matchAll(pattern)) {
    const separatorStart = match.index ?? 0;
    const content = body.slice(lastIndex, separatorStart);
    const separator = match[0];

    if (content.length === 0) {
      if (blocks.length > 0) {
        blocks[blocks.length - 1]!.separator += separator;
      }
      lastIndex = separatorStart + separator.length;
      continue;
    }

    blocks.push({ content, separator });
    lastIndex = separatorStart + separator.length;
  }

  const tail = body.slice(lastIndex);
  if (tail.length > 0 || blocks.length === 0) {
    blocks.push({ content: tail, separator: "" });
  }

  return blocks;
}
