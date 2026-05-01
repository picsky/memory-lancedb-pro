/**
 * Prompt templates for intelligent memory extraction.
 * Three mandatory prompts:
 * - buildExtractionPrompt: 6-category L0/L1/L2 extraction with few-shot
 * - buildDedupPrompt: CREATE/MERGE/SKIP dedup decision
 * - buildMergePrompt: Memory merge with three-level structure
 */

export function buildExtractionPrompt(
  conversationText: string,
  user: string,
): string {
  return `You are a memory extraction assistant. Analyze the conversation and extract memories worth long-term preservation for the user "${user}".

**Rules**:
- Output language MUST match the dominant language of the conversation.
- Only extract user-specific information, not general knowledge.
- Abstract must be 10-30 characters, include concrete nouns (names, products, tech).
- Maximum 5 memories per extraction.
- Each memory is ONE fact — do NOT merge unrelated facts into a single memory.
- NEVER extract:
  - Lines starting with "System:" (platform logs, model switches, channel info)
  - Message IDs (ou_xxx, msg_xxx, om_xxx) or user IDs
  - Platform names (Feishu, Telegram, Discord, Slack) as infrastructure context
  - Model switching events ("Model switched to X")
  - Channel metadata, heartbeat, dispatching logs
  - Timestamps, greetings, recall queries, tool output

**Categories**:
| category      | What it is                        | Test phrase              |
|---------------|-----------------------------------|--------------------------|
| profile       | User identity, role, background   | "User is..."             |
| preferences   | Preferences, habits, tendencies   | "User prefers..."        |
| entities      | Projects, tools, orgs, people     | "Project X uses..."      |
| events        | Decisions, milestones, meetings   | "User decided/completed" |
| cases         | Problem → solution pairs          | "When X fails, do Y"     |
| patterns      | Reusable processes or workflows   | "To handle X, do Y..."   |

**Examples**:

## profile
\`\`\`json
{"category":"profile","abstract":"用户是AI开发工程师，3年LLM经验","overview":"## 身份\\n- 职业: AI开发工程师\\n- 经验: 3年LLM开发","content":"用户是一名AI开发工程师，有3年LLM应用开发经验。"}
\`\`\`

## preferences
\`\`\`json
{"category":"preferences","abstract":"Python代码风格：无类型注解，简洁直接","overview":"## 偏好领域\\n- 语言: Python\\n- 主题: 代码风格\\n\\n## 细节\\n- 不使用类型注解\\n- 函数注释简洁","content":"用户偏好Python代码不使用类型注解，函数注释简洁直接。"}
\`\`\`

## entities
\`\`\`json
{"category":"entities","abstract":"项目使用Kong网关+PostgreSQL 16+PgBouncer","overview":"## 项目基础设施\\n- API网关: Kong\\n- 数据库: PostgreSQL 16\\n- 连接池: PgBouncer\\n- 部署: AWS us-east-1","content":"项目API网关使用Kong，部署在AWS us-east-1。数据库是PostgreSQL 16，使用PgBouncer做连接池。"}
\`\`\`

## events
\`\`\`json
{"category":"events","abstract":"用户向LanceDB提交了BigInt问题的GitHub issue","overview":"## 事件\\n- 时间: 近期\\n- 内容: 向LanceDB GitHub仓库报告了BigInt返回值问题","content":"用户在使用LanceDB 0.26时遇到BigInt问题，已向GitHub提交issue。"}
\`\`\`

## cases
\`\`\`json
{"category":"cases","abstract":"LanceDB BigInt返回值问题","overview":"## 问题\\nLanceDB 0.26+数值列返回BigInt类型\\n\\n## 解决方案\\n用Number()包装后再做算术运算","content":"当LanceDB返回BigInt值时，用Number()包装后再进行算术运算可解决兼容性问题。"}
\`\`\`

## patterns
\`\`\`json
{"category":"patterns","abstract":"大项目启动时先清理缓存再加载monorepo","overview":"## 可复用流程\\n- 场景: 打开大型monorepo项目\\n- 步骤: 清理缓存→重新加载→验证索引","content":"打开大型monorepo项目时，先清理编辑器缓存再重新加载，可避免加载卡顿。"}
\`\`\`

**Conversation**:
${conversationText}

**Output**: Return JSON ONLY:
{"memories":[{"category":"profile|preferences|entities|events|cases|patterns","abstract":"one-liner with concrete nouns","overview":"structured markdown overview","content":"full narrative"}]}

If nothing worth recording, return {"memories": []}.`;
}

export function buildDedupPrompt(
  candidateAbstract: string,
  candidateOverview: string,
  candidateContent: string,
  existingMemories: string,
): string {
  return `Determine how to handle this candidate memory.

**Candidate Memory**:
Abstract: ${candidateAbstract}
Overview: ${candidateOverview}
Content: ${candidateContent}

**Existing Similar Memories**:
${existingMemories}

Please decide:
- SKIP: Candidate memory duplicates existing memories, no need to save. Also SKIP if the candidate contains LESS information than an existing memory on the same topic (information degradation — e.g., candidate says "programming language preference" but existing memory already says "programming language preference: Python, TypeScript")
- CREATE: This is completely new information not covered by any existing memory, should be created
- MERGE: Candidate memory adds genuinely NEW details to an existing memory and should be merged
- SUPERSEDE: Candidate states that the same mutable fact has changed over time. Keep the old memory as historical but no longer current, and create a new current memory.
- SUPPORT: Candidate reinforces/confirms an existing memory in a specific context (e.g. "still prefers tea in the evening")
- CONTEXTUALIZE: Candidate adds a situational nuance to an existing memory (e.g. existing: "likes coffee", candidate: "prefers tea at night" — different context, same topic)
- CONTRADICT: Candidate directly contradicts an existing memory in a specific context (e.g. existing: "runs on weekends", candidate: "stopped running on weekends")

IMPORTANT:
- "events" and "cases" categories are independent records — they do NOT support MERGE/SUPERSEDE/SUPPORT/CONTEXTUALIZE/CONTRADICT. For these categories, only use SKIP or CREATE.
- If the candidate appears to be derived from a recall question (e.g., "Do you remember X?" / "你记得X吗？") and an existing memory already covers topic X with equal or more detail, you MUST choose SKIP.
- A candidate with less information than an existing memory on the same topic should NEVER be CREATED or MERGED — always SKIP.
- For "preferences" and "entities", use SUPERSEDE when the candidate replaces the current truth instead of adding detail or context. Example: existing "Preferred editor: VS Code", candidate "Preferred editor: Zed".
- For SUPPORT/CONTEXTUALIZE/CONTRADICT, you MUST provide a context_label from this vocabulary: general, morning, evening, night, weekday, weekend, work, leisure, summer, winter, travel.

Return JSON format:
{
  "decision": "skip|create|merge|supersede|support|contextualize|contradict",
  "match_index": 1,
  "reason": "Decision reason",
  "context_label": "evening"
}

- If decision is "merge"/"supersede"/"support"/"contextualize"/"contradict", set "match_index" to the number of the existing memory (1-based).
- Only include "context_label" for support/contextualize/contradict decisions.`;
}

export function buildMergePrompt(
  existingAbstract: string,
  existingOverview: string,
  existingContent: string,
  newAbstract: string,
  newOverview: string,
  newContent: string,
  category: string,
): string {
  return `Merge the following memory into a single coherent record with all three levels.

** Category **: ${category}

** Existing Memory:**
    Abstract: ${existingAbstract}
  Overview:
${existingOverview}
  Content:
${existingContent}

** New Information:**
    Abstract: ${newAbstract}
  Overview:
${newOverview}
  Content:
${newContent}

  Requirements:
  - Remove duplicate information
    - Keep the most up - to - date details
      - Maintain a coherent narrative
        - Keep code identifiers / URIs / model names unchanged when they are proper nouns

Return JSON:
  {
    "abstract": "Merged one-line abstract",
      "overview": "Merged structured Markdown overview",
        "content": "Merged full content"
  } `;
}
