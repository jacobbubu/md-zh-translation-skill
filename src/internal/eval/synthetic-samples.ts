export const SYNTHETIC_REGRESSION_CASES = [
  {
    id: "title-bilingual-boundary",
    description: "Titles and standfirsts must not append whole English sentences when only a term needs bilingual treatment."
  },
  {
    id: "first-mention-bilingual",
    description: "First mentions in headings, lists, and body paragraphs must use Chinese-English paired forms."
  },
  {
    id: "unit-conversion-boundary",
    description: "Only length, weight, Fahrenheit temperature, and rainfall inches may receive added metric conversions."
  },
  {
    id: "markdown-preservation",
    description: "Code fences, inline code, link targets, and raw HTML must survive translation unchanged."
  }
] as const;
