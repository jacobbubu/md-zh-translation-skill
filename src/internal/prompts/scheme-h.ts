const MARKDOWN_RULES = `
Markdown 结构要求：
1. 保留原有 Markdown 结构，不要删掉或新增段落之外的结构元素。
2. 不要改写 fenced code blocks、indented code blocks、inline code、URL、链接目标、图片 URL 和原始 HTML 标签。
3. 链接或图片的可见文字如果是正文，可以翻译；目标地址必须保持不变。
4. 不要把代码块、命令行片段或配置键值误译成中文。
5. 如果原文正文使用了可翻译的 Markdown 强调结构（如 **加粗**、*斜体*）或命令/flag 写法（如 --flag），译文应保持等价结构；不要丢掉强调，也不要把普通命令/flag 误改成代码块、标题或其他 Markdown 结构。
`.trim();

export const DOCUMENT_ANALYSIS_PROMPT = `
你是一名科技与科普翻译编辑的前置分析器。请阅读下面的整篇 Markdown 文档分析输入，并只返回 JSON，不要返回散文说明。

目标：
1. 找出全文里需要建立“首次中英锚定”的候选专名、产品名、机构名、项目名和关键术语。
2. 标出它们在全文中的首次出现位置（chunkId + segmentId）。
3. 将同一概念家族的不同英文变体归并到同一个 familyKey。
4. 如果你能高置信判断其首现显示策略，请额外给出 displayPolicy。
5. 对明显不需要强制双语锚定的通用词，放进 ignoredTerms。

要求：
1. 只返回 JSON。
2. anchors 中每一项都必须包含：
   - english
   - chineseHint
   - familyKey
   - firstOccurrence.chunkId
   - firstOccurrence.segmentId
   可选包含：
   - category（如 product / tool / framework / platform / company / other）
   - displayPolicy（可选值：english-only / english-primary / chinese-primary / acronym-compound / auto）
3. english 必须是原文里实际出现的英文形式，不要杜撰。
4. chineseHint 只写最小必要的中文主译或中文说明，不要写整句。
5. familyKey 用于归并同一概念家族，保持稳定、简短、可复用。
6. displayPolicy 只在你有高置信时填写；没有把握时省略，让程序走默认策略。
7. 只有真正需要首现双语锚定的项才放进 anchors。像 Earth、reptiles、paleontologist 这类通用名词、职业称谓、类群名或常见科学词，通常应放进 ignoredTerms。
8. 如果同一项在标题、引用、列表项和正文中都出现，首次出现位置必须精确落在最先出现的那个 chunkId / segmentId。
9. 不要输出重复的 anchors。

返回格式：
{
  "anchors": [
    {
      "english": "Prompt injection attacks",
      "chineseHint": "提示注入攻击",
      "familyKey": "prompt injection attacks",
      "displayPolicy": "chinese-primary",
      "firstOccurrence": {
        "chunkId": "chunk-3",
        "segmentId": "chunk-3-segment-1"
      }
    }
  ],
  "ignoredTerms": [
    {
      "english": "Earth",
      "reason": "通用名词"
    }
  ]
}

【文档分析输入】
{{document}}
`.trim();

export const INITIAL_TRANSLATION_PROMPT = `
你是一名科技与科普翻译编辑。请把下面的英文 Markdown 文章翻译成自然、准确、可读性高的中文 Markdown，但本次任务以“硬性项正确”为第一优先级。请严格遵守以下要求：

1. 只输出译文，不要解释、不要总结、不要添加标题或注释。
2. 译文段落数必须与原文完全一致。每个英文段落对应一个中文段落，不得合并、拆分、重排。
3. 只有以下内容第一次出现时才必须中英文对照，优先使用“中文（英文）”格式：人名、机构名、公司名、产品名、论文/期刊/会议名、专有项目名，以及对理解文章确实关键且中文读者未必熟悉的专业术语。这里的“关键专业术语”包括两类：一是明显的领域术语；二是虽然是常见科学名词，但在本文中反复出现、承载核心发现或后文持续围绕其展开的概念，例如某种材料、器官部位、结构名称、实验过程或关键机制。文章标题、各级标题、列表项中的首次出现也算首次出现。若某一列表或并列结构中首次出现多个州名、地区名、风暴名或术语，要逐项补齐，不要只给列表整体补一次。注意：中英文对照只针对这些局部元素本身，不要把整条标题、导语句、小标题或列表项原句整句附上英文；像 Earth、reptiles、paleontologist 这类通用名词、职业称谓、类群名或常见科学词，不要为了凑双语而强行加英文。
   如果上文上下文里已经给出“前文已完成首现锚定的专名/术语”清单，则清单内条目及其明显简称都视为已经在全文前文完成首现双语锚定；它们在当前分块标题、各级标题、列表项或正文里再次出现时，不要重复补首次中英文对照。
   对没有成熟中文主译的产品名、系统名、工具名、命令名、框架名或操作系统名，如果需要建立首现锚定，可使用“英文原名（中文说明）”“中文说明（英文原名）”或其他自然的中英说明形式；严禁写成“Foo（Foo）”“Linux（Linux）”“Claude Code（Claude Code）”这种英文重复括注。
4. 缩写第一次出现时，优先写成“中文全称（英文全称，缩写）”或最自然的中英文对照形式；若保留英文缩写并补中文解释，必须使用中文全角括号，例如“CNN（美国有线电视新闻网）”，不要写成“CNN (...)”。后文保持译法一致。
5. 数字、年份、单位、比较关系、因果关系、条件关系必须准确，不得遗漏、增补或偷换。
6. 如果原文使用英制数量和单位，请按以下规则处理：
   - 描述长度或重量时，保留原英制表达，并在后面括注常见公制换算。
   - 描述华氏温度时，可以保留华氏度，并在后面括注摄氏度。
   - 描述以英寸表示的累计降水量时，可以保留英寸，并在后面括注毫米。
   - 除以上情况外，其他类型单位不要擅自补充换算。
7. 除非原文中有需要原样保留的完整英文段落，否则全篇使用中文标点。
8. 中文表达应自然、清楚、准确，但不要为了顺口牺牲硬性规则。
9. 严禁在译文中加入任何过程说明、自我说明或提示语。
10. 除翻译所必需的内容外，不要输出任何多余说明。
11. 如果同一个核心概念在全文里有多个英文变体，例如 iron-coated teeth / iron coating / iron-enriched coating，必须在第一次出现时就确定一个稳定的中文主译法，并在后文保持同一概念家族的中英文对应关系，不要到后文才第一次补对照，也不要前后换叫法。

${MARKDOWN_RULES}

输出前请自行检查：
- 段落数是否与原文完全一致。
- 首次出现的人名、机构名、公司名、产品名、论文/期刊/会议名、专有项目名和真正关键的专业术语是否都已中英文对照，包括标题、各级标题、列表项和正文中的第一次出现。
- 是否避免给通用名词、职业称谓、类群名或常见科学词硬加英文括注。
- 是否只对局部专名或术语做了中英文对照，而没有把整条标题、导语句、小标题或列表项整句附上英文原文。
- 同一核心概念的不同英文变体是否使用了稳定一致的中文主译法和双语对应关系。
- 数字、年份、单位、比较关系、逻辑关系是否准确。
- 长度、重量、华氏温度、以英寸表示的累计降水量是否按规则补充了常见换算，其他单位是否没有被擅自换算。
- 标点是否符合中文习惯，尤其中文句内的括注是否统一使用全角括号。

【英文原文】
{{source}}
`.trim();

export const GATE_AUDIT_PROMPT = `
请检查下面的英文原文和当前译文，只做“硬性项审校”，不要润色，不要改写，不要输出修订稿。

只返回 JSON，对应格式如下：
{
  "hard_checks": {
    "paragraph_match": { "pass": true, "problem": "" },
    "first_mention_bilingual": { "pass": true, "problem": "" },
    "numbers_units_logic": { "pass": true, "problem": "" },
    "chinese_punctuation": { "pass": true, "problem": "" },
    "unit_conversion_boundary": { "pass": true, "problem": "" },
    "protected_span_integrity": { "pass": true, "problem": "" }
  },
  "must_fix": [
    "逐条列出必须修复的问题，描述要具体、可执行"
  ]
}

审校口径：
1. paragraph_match：段落数和段落顺序是否严格对应原文。
2. first_mention_bilingual：人名、机构名、公司名、产品名、论文/期刊/会议名、专有项目名以及真正关键的专业术语第一次出现时是否完成中英文对照；标题、各级标题、列表项和正文中的第一次出现都要检查。这里的关键术语不仅包括明显的领域术语，也包括在本文中反复出现、承载核心发现或后文持续围绕其展开的科学名词。遇到州名、地区名、风暴名、并列术语或列表枚举时，要逐项检查。同时要判定对照范围是否过宽；如果把整条标题、导语句、小标题或列表项原句整句附上英文，或者给 Earth、reptiles、paleontologist 这类通用名词、职业称谓、类群名、常见科学词硬加英文，也应判为不通过。若同一核心概念存在多个英文变体，要检查是否在首次出现时就建立了稳定的双语对应，不能到后文某个变体出现时才第一次补英文。
   如果上文上下文里已经给出“前文已完成首现锚定的专名/术语”清单，则清单内条目及其明显简称一律视为已经在全文前文完成首现双语锚定；即使它们在当前分块标题、各级标题、列表项或正文里是本块第一次出现，也不得再按“首现缺少中英文对照”判错。
   对没有成熟中文主译的产品名、系统名、工具名、命令名、框架名或操作系统名，如果译文写成“Foo（Foo）”这类英文重复括注，仍应判为不通过；这类情况必须改成带中文说明的自然中英锚定形式。
3. numbers_units_logic：数字、年份、单位、比较关系、逻辑关系是否没有明显错漏。
4. chinese_punctuation：是否符合中文标点习惯；如果保留完整英文段落，该英文段落内部可保留英文标点，不单独判错。中文句内若保留英文缩写并补中文解释，括号必须是全角，例如“CNN（美国有线电视新闻网）”。
5. unit_conversion_boundary：长度、重量、华氏温度、以英寸表示的累计降水量是否按规则补常见换算，其他单位是否没有被擅自换算。
6. protected_span_integrity：所有占位符是否逐字保留、没有丢失、没有改写、没有增删、没有被污染进别的文本。

输出要求：
- 只返回 JSON。
- problem 要简短具体。
- must_fix 只写必须修的硬性问题，不写风格建议。
- must_fix 必须原子化，一条只写一个具体问题。
- 每条 must_fix 都要写清位置、问题和修复目标。
- 如果某个 hard_check 判为 false，对应问题必须在 must_fix 中完整覆盖，不得遗漏。
- 如果 protected_span_integrity 不通过，必须明确写出具体污染位置或被破坏的占位符，但不要输出修订稿。

${MARKDOWN_RULES}

【英文原文】
{{source}}

【当前译文】
{{translation}}
`.trim();

export const BUNDLED_GATE_AUDIT_PROMPT = `
请检查下面按 segment 编号提供的英文原文与当前译文，只做“硬性项审校”，不要润色，不要改写，不要输出修订稿。

只返回 JSON，对应格式如下：
{
  "segments": [
    {
      "segment_index": 1,
      "hard_checks": {
        "paragraph_match": { "pass": true, "problem": "" },
        "first_mention_bilingual": { "pass": true, "problem": "" },
        "numbers_units_logic": { "pass": true, "problem": "" },
        "chinese_punctuation": { "pass": true, "problem": "" },
        "unit_conversion_boundary": { "pass": true, "problem": "" },
        "protected_span_integrity": { "pass": true, "problem": "" }
      },
      "must_fix": [
        "逐条列出必须修复的问题，描述要具体、可执行"
      ]
    }
  ]
}

审校口径与单段审校完全一致，但必须按 segment 分别返回结果：
1. paragraph_match：该 segment 的段落数和段落顺序是否严格对应原文。
2. first_mention_bilingual：该 segment 中的人名、机构名、公司名、产品名、论文/期刊/会议名、专有项目名以及真正关键的专业术语第一次出现时是否完成中英文对照；标题、各级标题、列表项和正文中的第一次出现都要检查。这里的关键术语不仅包括明显的领域术语，也包括在本文中反复出现、承载核心发现或后文持续围绕其展开的科学名词。遇到州名、地区名、风暴名、并列术语或列表枚举时，要逐项检查。同时要判定对照范围是否过宽；如果把整条标题、导语句、小标题或列表项原句整句附上英文，或者给 Earth、reptiles、paleontologist 这类通用名词、职业称谓、类群名、常见科学词硬加英文，也应判为不通过。若同一核心概念存在多个英文变体，要检查是否在首次出现时就建立了稳定的双语对应，不能到后文某个变体出现时才第一次补英文。
   如果上文上下文里已经给出“前文已完成首现锚定的专名/术语”清单，则清单内条目及其明显简称一律视为已经在全文前文完成首现双语锚定；即使它们在当前分块标题、各级标题、列表项或正文里是本块第一次出现，也不得再按“首现缺少中英文对照”判错。
   对没有成熟中文主译的产品名、系统名、工具名、命令名、框架名或操作系统名，如果译文写成“Foo（Foo）”这类英文重复括注，仍应判为不通过；这类情况必须改成带中文说明的自然中英锚定形式。
3. numbers_units_logic：数字、年份、单位、比较关系、逻辑关系是否没有明显错漏。
4. chinese_punctuation：是否符合中文标点习惯；如果保留完整英文段落，该英文段落内部可保留英文标点，不单独判错。中文句内若保留英文缩写并补中文解释，括号必须是全角，例如“CNN（美国有线电视新闻网）”。
5. unit_conversion_boundary：长度、重量、华氏温度、以英寸表示的累计降水量是否按规则补常见换算，其他单位是否没有被擅自换算。
6. protected_span_integrity：所有占位符是否逐字保留、没有丢失、没有改写、没有增删、没有被污染进别的文本。

输出要求：
- 只返回 JSON。
- 每个 segment_index 只返回一个对象。
- problem 要简短具体。
- must_fix 只写必须修的硬性问题，不写风格建议。
- must_fix 必须原子化，一条只写一个具体问题。
- 每条 must_fix 都要写清位置、问题和修复目标。
- 如果某个 hard_check 判为 false，对应问题必须在该 segment 的 must_fix 中完整覆盖，不得遗漏。
- 如果 protected_span_integrity 不通过，必须明确写出具体污染位置或被破坏的占位符，但不要输出修订稿。

${MARKDOWN_RULES}

【分段审校输入】
{{segments}}
`.trim();

export const REPAIR_PROMPT = `
请根据英文原文、当前译文和“must_fix”问题清单，只修复这些具体问题，不做额外润色，不重写全文风格。

要求：
1. 只输出修订后的完整译文，不要解释。
2. 保持段落数与段落顺序严格不变。
3. 必须逐条执行 must_fix，不能只修其中一部分。
4. 优先做局部补丁式修改，只改 must_fix 指向的位置或与之直接相邻的最小文本范围，不要整段重写。
5. 没有列入 must_fix 的段落尽量不改；如果某段原本已经有正确的中英文对照、数字、单位换算或中文标点，修复时不得删除、改丢或简化。
6. 对“首次出现中英文对照”问题，修复后的首次出现必须直接写成“中文（英文）”或等价的自然双语形式；标题、各级标题、列表项也适用，但只补局部专名或真正关键的专业术语，不得把整条标题、导语句、小标题或列表项原句整句附上英文，也不得给通用名词、职业称谓、类群名或常见科学词硬加英文。若某个科学名词在本文中反复出现、承载核心发现或后文持续围绕其展开，即使它本身是常见名词，也应按关键术语处理。若 must_fix 指出的是同一核心概念家族前后不一致，修复时要统一主译法和双语锚点。
   如果上文上下文里已经给出“前文已完成首现锚定的专名/术语”清单，则清单内条目及其明显简称都视为已经在全文前文完成首现双语锚定；修复时不要因为当前分块标题、各级标题、列表项或正文里再次出现这些条目，就重复补首现中英文对照。
   对没有成熟中文主译的产品名、系统名、工具名、命令名、框架名或操作系统名，不要修成“Foo（Foo）”这类英文重复括注；应改成“英文原名（中文说明）”“中文说明（英文原名）”或其他自然的中英说明形式。
7. 如果 must_fix 同时要求“保持原文名”和“补中文对照”，目标形式应是“中文（英文）”，不要只保留英文或只保留中文。
8. 如果同一段里有多条 must_fix，允许一次性补齐，但修完后要保留这段原有的其他正确信息，不得因为补一个术语而删掉另一个已正确的对照或换算。
9. 输出前按以下顺序自检：段落对应、首现中英对照、数字单位逻辑、中文标点、单位换算边界，确认 must_fix 中列出的每一项都已经修掉，并确认原本已正确的中英文对照和单位换算没有被修丢。
10. 不要引入新的中英对照遗漏、数字单位错误、标点错误或单位换算边界错误；中文句内若需保留英文缩写并补中文解释，统一写成全角括号形式。
11. 如果 must_fix 为空，则原样输出当前译文。

${MARKDOWN_RULES}

【英文原文】
{{source}}

【当前译文】
{{translation}}

【must_fix】
{{mustFix}}
`.trim();

export const STYLE_POLISH_PROMPT = `
请基于英文原文和当前译文，只做“风格与可读性润色”。本轮默认硬性项已经通过，因此你不得改变：

1. 段落数和段落顺序。
2. 人名、机构名、术语的中英文对照形式。
3. 数字、年份、单位、比较关系和逻辑关系。
4. 已有的单位换算口径。
5. Markdown 结构、代码块、行内代码、链接目标、图片 URL 和原始 HTML。

只允许做以下优化：
1. 删除翻译腔，让句子更像自然中文。
2. 在不改变事实和结构的前提下，尽量保留原文语气、节奏、叙述距离和轻重缓急。
3. 微调个别句子，让中文更顺，但不得扩写、删减或重排。

输出修订后的完整译文，不要解释。

【英文原文】
{{source}}

【当前译文】
{{translation}}
`.trim();

export function buildInitialPrompt(source: string): string {
  return INITIAL_TRANSLATION_PROMPT.replaceAll("{{source}}", source);
}

export function buildDocumentAnalysisPrompt(document: string): string {
  return DOCUMENT_ANALYSIS_PROMPT.replaceAll("{{document}}", document);
}

export function buildGateAuditPrompt(source: string, translation: string): string {
  return GATE_AUDIT_PROMPT.replaceAll("{{source}}", source).replaceAll("{{translation}}", translation);
}

export function buildBundledGateAuditPrompt(segments: string): string {
  return BUNDLED_GATE_AUDIT_PROMPT.replaceAll("{{segments}}", segments);
}

export function buildRepairPrompt(source: string, translation: string, mustFix: readonly string[]): string {
  const mustFixText = mustFix.length === 0 ? "无" : mustFix.map((item) => `- ${item}`).join("\n");
  return REPAIR_PROMPT.replaceAll("{{source}}", source)
    .replaceAll("{{translation}}", translation)
    .replaceAll("{{mustFix}}", mustFixText);
}

export function buildStylePolishPrompt(source: string, translation: string): string {
  return STYLE_POLISH_PROMPT.replaceAll("{{source}}", source).replaceAll("{{translation}}", translation);
}
