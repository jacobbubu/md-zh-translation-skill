# known_entities 收编准则

这份文档定义 `src/data/known_entities.json` 的用途、收编标准和排除标准。

目标不是做“翻译词典”，而是维护一份**稳定的首现显示策略表**，帮助状态机在进入 `draft / audit / repair` 之前，先把一部分高价值、高复用、低歧义的实体处理成程序规则。

## 1. 这份表解决什么问题

`known_entities.json` 只负责一件事：

- 预先声明某个英文实体在首次出现时允许什么显示策略

它不负责：

- 充当通用术语词典
- 代替全文分析
- 替所有英文词生成中文翻译
- 处理文件路径、命令、flag、代码块或 Markdown 结构

## 2. 允许的显示策略

当前支持的策略只有这几类：

- `bare_english_ok`
  - 允许首次出现直接裸英文
  - 适合广泛已知的产品、平台、框架、公司名
- `english_primary_with_cn_hint`
  - 保留英文主名，必要时补最小中文说明
  - 适合工具名、项目名、模式名
- `chinese_primary_with_en_anchor`
  - 使用中文主译，并在首现处补英文锚点
  - 适合普通概念术语
- `acronym_compound`
  - 适合 `SSH keys`、`API tokens`、`RAG`、`PyPI` 这类缩写复合术语
- `no_forced_anchor`
  - 不强制在正式表中主动注入锚点，只保留作为已知实体参考

## 3. 进入正式表的必要条件

候选实体只有同时满足下面这些条件，才允许升入 `known_entities.json`：

### 3.1 跨文档稳定

- 这个实体不是只在单篇文章里偶然出现
- 换一篇同类技术文章时，它的身份和显示策略仍然成立

### 3.2 首现显示策略明确

- 我们能清楚判断它属于哪一种 `display_policy`
- 不需要依赖上下文反复猜测

### 3.3 不容易与结构规则冲突

- 不会高频落在 command phrase、inline code、link label、path、文件名、flag、配置键名这些高风险位置
- 不会和现有的 plain/inline code 规则、heading 模板恢复规则、source surface 约束直接打架

### 3.4 中文说明稳定

- 如果不是 `bare_english_ok`，那它的中文说明必须足够稳定
- 不能出现“同文重复回括”或高度依赖单篇语境的解释

### 3.5 工程收益明显

- 把它收进正式表之后，能减少真实回归中的反复错误
- 而不是只会增加新的规范化冲突

## 4. 明确不应进入正式表的内容

以下内容默认只应停留在候选层，或完全不进入 `known_entities.json`：

### 4.1 文件和路径

- `.gitignore`
- `CLAUDE.md`
- `.claude/settings.json`
- `.claude/settings.local.json`
- `claude-sandbox.config.json`

原因：

- 它们更像路径/文件名，不是稳定实体
- 应由结构保护和 source-shape 规则处理

### 4.2 命令、flag、CLI 片段

- `--dangerously-skip-permissions`
- `git status`
- `python script.py`
- `npm install`

原因：

- 它们处在最容易与 plain/inline code 规则冲突的位置
- 应由命令短语与代码形态规则处理，不应由实体表注入

### 4.3 单篇标题短语或局部组合词

- `Filesystem Isolation`
- `Network Isolation`
- `Command Restrictions`
- `MCP server integrations`
- `React/Next.js Web Project Configuration Example`

原因：

- 它们往往是某篇文章的标题模板组成部分
- 应由 heading 模板恢复或全文分析处理，而不是写死进正式表

### 4.4 高耦合工程实体

像下面这类条目，默认先留在候选层，不急着升正式表：

- `bubblewrap`
- `Seatbelt`
- `npm registry`
- `Python`
- `Node.js`
- `Anthropic`

原因：

- 它们很容易出现在链接、命令、列表标签、标题组合词或英文主名型说明里
- 一旦正式入表，常常会和现有锚点注入、display normalization、plain/inline code 规则互相放大

## 5. 推荐收编的优先级

优先收编这几类：

### 5.1 稳定概念术语

- `sandbox mode`
- `prompt injection attacks`
- `supply chain attacks`

特征：

- 语义清晰
- 中文主译稳定
- 不容易进入 command/path/code 区域

### 5.2 稳定英文主名型模式/项目名

- `YOLO mode`

特征：

- 英文主名稳定
- 中文说明简洁
- 不容易和路径或命令形态冲突

### 5.3 稳定缩写复合术语

- `RAG`
- `PyPI`
- `SSH keys`
- `API tokens`

特征：

- 结构模式明确
- display policy 可直接程序化

## 6. 候选到正式的工作流

推荐流程固定为：

1. 长文回归时用 `MDZH_KNOWN_ENTITIES_CANDIDATES_PATH` 导出候选表
2. 按这份文档先做人为初筛
3. 只把“低风险 + 高复用 + 显示策略明确”的条目加入 `known_entities.json`
4. 加入后必须补：
   - 对应单测
   - 至少一条会命中该实体的状态机测试
5. 再跑 `npm run verify`
6. 再做真实长文回归，观察是否出现新的 linked bug

## 7. 判断口诀

如果一个候选实体满足下面这句话，才适合进入正式表：

- **“它在别的文章里也大概率成立，而且不会轻易碰到命令、路径、代码、链接或标题模板边界。”**

如果不满足，就先放在候选表，不要急着收编。
