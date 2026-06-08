/**
 * 统一分析器服务
 *
 * 功能：
 * 1. 从录制会话中提取数据流
 * 2. 调用 LLM 分析操作模式
 * 3. 生成通用自动化模板
 */

import type { RecordingSession, DetectedPattern, PatternType } from '@/types/recording-session';
import type { AutomationTemplate, TemplateStep, TemplateParameter } from '@/types/automation-template';
import type { DataFlow, DataSource, DataTarget, FieldMapping, DataField } from '@/types/unified-data';
import type { SemanticEvent } from '@/types/semantic-event';
import type { UnifiedAction } from '@/types/unified-action';
import type { IModelService } from '@/interfaces/model-service';
import type { ProviderConfig } from '@/types/provider';
import { ModelScenario } from '@/services/llm-gateway/gateway';

/**
 * LLM 分析结果
 */
interface LLMAnalysisResult {
  pattern: {
    type: PatternType;
    confidence: number;
    description: string;
    loopVariable?: string;
    loopSource?: string;
    loopBodyIndices?: number[];
    count?: number;                    // 循环次数（用于坐标参数化场景）
  };
  dataFlow?: {
    source: {
      type: string;
      fields: string[];
    };
    target: {
      type: string;
      fields: string[];
    };
    mapping: Array<{
      source: string;
      target: string;
    }>;
  };
  parameters: Array<{
    name: string;
    description: string;
    type: string;
    required: boolean;
  }>;
  steps: Array<{
    action: string;
    description: string;
    target?: {
      semantic?: {
        role: string;
        name: string;
      };
      path?: string;
      coordinate?: {
        x: number | string;
        y: number | string;
      };
    };
    waitBefore?: number;
    params?: Record<string, unknown>;
    control?: {
      type: string;
      over?: string;
      variable?: string;
      body?: string[];
    };
  }>;
}

/**
 * 统一分析器
 */
class UnifiedAnalyzer {
  constructor(
    private modelService?: IModelService,
    private provider?: ProviderConfig,
    private apiKey?: string,
  ) {}

  /**
   * 设置 LLM 配置
   */
  configure(modelService: IModelService, provider: ProviderConfig, apiKey: string): void {
    this.modelService = modelService;
    this.provider = provider;
    this.apiKey = apiKey;
  }

  /**
   * 单次 LLM 调用完成分析+生成
   */
  private async analyzeAndGenerateWithLLM(
    session: RecordingSession,
    dataFlow: DataFlow | null,
  ): Promise<AutomationTemplate> {
    // 构建组合 prompt（分析+生成一步到位）
    const prompt = this.buildCombinedPrompt(session, dataFlow);

    // 调用 LLM
    const response = await this.callLLM(prompt);
    console.log('[UnifiedAnalyzer] LLM raw response length:', response.length);
    console.log('[UnifiedAnalyzer] LLM raw response preview:', response.substring(0, 500));

    // 解析结果
    const result = this.parseLLMResponse(response);

    // 构建 pattern
    const pattern: DetectedPattern = {
      type: result.pattern.type,
      confidence: result.pattern.confidence,
      description: result.pattern.description,
      loopVariable: result.pattern.loopVariable || (result.pattern.count !== undefined ? 'index' : undefined),
      loopSource: result.pattern.loopSource || (result.pattern.count !== undefined ? String(result.pattern.count) : undefined),
      dataFlow: dataFlow || undefined,
    };

    return {
      id: crypto.randomUUID(),
      name: session.metadata.userDescription || 'Recorded Template',
      description: pattern.description,
      version: '1.0.0',
      dataFlow: dataFlow || undefined,
      parameters: result.parameters.map(p => ({
        name: p.name,
        description: p.description,
        type: p.type as TemplateParameter['type'],
        required: p.required,
      })),
      steps: result.steps.map((step, index) => ({
        id: `step_${index}`,
        action: step.action,
        description: step.description,
        target: step.target ? {
          semantic: step.target.semantic,
          path: step.target.path,
          coordinate: step.target.coordinate,
        } : undefined,
        waitBefore: step.waitBefore,
        params: step.params,
        control: step.control ? {
          type: step.control.type as TemplateStep['control'] extends { type: infer T } ? T : never,
          over: step.control.over,
          variable: step.control.variable,
          body: step.control.body,
        } : undefined,
      })),
      createdAt: Date.now(),
      sourceSession: session.id,
      llmModel: this.provider?.model,
    };
  }

  /**
   * 构建组合 prompt（分析+生成一步到位）
   */
  private buildCombinedPrompt(session: RecordingSession, dataFlow: DataFlow | null): string {
    const windowSet = new Set<string>();
    for (const e of session.events) {
      const title = e.context?.windowTitle;
      if (title) windowSet.add(title);
    }
    const windowList = [...windowSet].join('、') || '未知';

    const eventsSummary = session.events.map((e, i) => {
      const action = e.action.type;
      const target = this.describeTarget(e.action.target, e.action.params);
      const element = e.element
        ? `[${e.element.identity.role}] "${e.element.identity.name}"`
        : '';
      const structure = e.element?.structure
        ? ` (in ${e.element.structure.container?.role})`
        : '';
      const window = e.context?.windowTitle ? ` @ "${e.context.windowTitle}"` : '';
      // For drag, show start→end; for others, show coordinate
      let coord = '';
      if (action === 'drag' && e.action.params?.start_x !== undefined) {
        coord = ` (${e.action.params.start_x},${e.action.params.start_y})→(${e.action.params.end_x},${e.action.params.end_y})`;
      } else if (e.action.target?.coordinate) {
        coord = ` (${e.action.target.coordinate.x},${e.action.target.coordinate.y})`;
      }
      const key = e.action.params?.key ? ` key="${e.action.params.key}"` : '';
      const waitBefore = i > 0 ? e.timestamp - session.events[i - 1].timestamp : 0;
      const waitStr = waitBefore > 100 ? ` [等待${Math.round(waitBefore)}ms]` : '';

      return `${i + 1}. ${action}${coord} ${element}${structure}${window}${key}${waitStr}`;
    }).join('\n');

    const dataFlowSummary = dataFlow
      ? `
## 数据流

源: ${dataFlow.source.type} - ${dataFlow.source.fields.map(f => f.name).join(', ')}
目标: ${dataFlow.target.type} - ${dataFlow.target.fields.map(f => f.name).join(', ')}
映射: ${dataFlow.mapping.map(m => `${m.source} → ${m.target}`).join(', ')}
`
      : '';

    // 检测坐标规律
    const coordPatterns = this.detectCoordinatePatterns(session.events);
    const coordPatternsSummary = this.buildCoordinatePatternsSummary(coordPatterns);

    const duration = session.endTime && session.startTime
      ? `${Math.round((session.endTime - session.startTime) / 1000)}秒`
      : '未知';

    return `## 操作录制分析与模板生成

### 录制概况
- 操作数量: ${session.events.length} 个
- 录制时长: ${duration}
- 涉及窗口: ${windowList}
- 用户描述: ${session.metadata.userDescription || '无'}

### 操作序列（含录制到的具体窗口名、元素名、坐标、按键）

${eventsSummary}
${dataFlowSummary}
${coordPatternsSummary}

### 任务要求

1. **分析模式**：识别操作模式（循环/线性/数据流）
2. **窗口标题、元素名称、按键**等固定值直接硬编码到 steps 中，不要抽象成参数
3. **坐标参数化（关键）**：
   - 如果"坐标规律检测"发现了线性规律，**必须**使用循环 + 坐标公式，不要硬编码每次迭代的具体坐标
   - 坐标公式格式：\`{{base + index * step}}\`，其中 index 是循环变量（从 0 开始）
   - 示例：录制到 (320,150), (316,210), (322,270) → 检测到 x≈320 固定, y=150+index*60 → 生成 \`{"x": "{{320}}", "y": "{{150 + index * 60}}"}\`
   - 固定轴直接用固定值（如 x=320），变化轴用公式（如 y=150+index*60）
   - 循环次数由 pattern.count 指定，loop_start 的 over 设为 count 数字
4. **如果没有坐标规律**，则直接使用录制到的具体坐标值
5. **每步标注目标窗口**：使用录制到的实际窗口标题
6. **过滤无意义事件**：跳过 key_up（按键释放）事件，只保留 key_down 和点击事件
7. **保留操作间隔**：每步的 waitBefore 是录制时的实际等待时间（ms），必须原样写入 steps 中的 waitBefore 字段，不要省略
8. **跳过无效目标**：如果某个步骤的 target role 为 "unknown" 且 name 为空，则跳过该步骤（如窗口切换的中间点击）
9. **循环控制**：当检测到循环模式时，使用 loop_start 和 loop_end 控制结构包裹循环体步骤
10. **拖动操作**：drag 是一个完整动作，包含 start_x/start_y/end_x/end_y 四个坐标参数。事件摘要中显示为 "drag (x1,y1)→(x2,y2)"。生成步骤时，action="drag"，params 中必须包含 start_x, start_y, end_x, end_y
11. **代码转换步骤（可选）**：当操作涉及数据加工时（去符号、格式转换、过滤、计算等），可在关键步骤之间插入 action="code" 的步骤。代码运行在沙箱中，可用变量：
    - \`vars\` — 读写上下文变量（vars.clipboard 获取剪贴板，vars.xxx = value 设置变量）
    - \`params\` — 当前步骤的参数
    - \`ok(msg, data)\` / \`fail(msg)\` — 返回结果
    - 代码中可用 fetch、JSON、Math、Date、RegExp 等标准 API
    - 示例：复制价格后去掉 ¥ 符号并转数字 → \`vars.price = parseFloat(vars.clipboard.replace('¥', ''))\`

### 输出格式

返回纯 JSON，不要添加任何说明文字。JSON 中所有字符串值必须正确转义：
- 字符串内部的双引号必须写成 \\" （例如："描述中包含\\"引号\\"的内容"）
- 字符串内部的反斜杠必须写成 \\\\
- 字符串内部不能出现未转义的双引号，否则 JSON 解析会失败

\`\`\`json
{
  "pattern": {
    "type": "loop",
    "confidence": 0.95,
    "description": "模式描述",
    "loopVariable": "index",
    "loopSource": "count",
    "count": 5
  },
  "parameters": [],
  "steps": [
    {
      "action": "loop_start",
      "description": "开始循环",
      "params": { "over": 5, "variable": "index" }
    },
    {
      "action": "click",
      "description": "点击浏览器中的数据行",
      "target": {
        "coordinate": { "x": "{{320}}", "y": "{{150 + index * 60}}" }
      },
      "window": "Google Chrome",
      "waitBefore": 350,
      "params": {}
    },
    {
      "action": "hotkey",
      "description": "复制",
      "params": { "key": "Ctrl+c" }
    },
    {
      "action": "drag",
      "description": "拖动选择区域",
      "target": { "coordinate": { "x": 421, "y": 698 } },
      "window": "PixPin",
      "waitBefore": 500,
      "params": { "start_x": 9, "start_y": 613, "end_x": 421, "end_y": 698 }
    },
    {
      "action": "code",
      "description": "转换数据格式",
      "params": {
        "code": "vars.value = vars.clipboard.replace(/[^\\d.]/g, '')"
      }
    },
    {
      "action": "loop_end",
      "description": "结束循环"
    }
  ]
}
\`\`\`

注意：当检测到坐标规律时，coordinate 必须使用模板表达式（如 "{{150 + index * 60}}"），不要硬编码具体坐标。loop_start 的 over 字段使用数字表示循环次数。

注意：parameters 数组在大多数情况下应该为空，除非有真正需要用户每次执行时指定的变量。

注意：code 步骤仅在需要数据加工时使用，简单的复制粘贴不需要插入 code 步骤。code 必须是单行或多行合法 JS 代码字符串。
`;
  }

  /**
   * 分析录制会话，生成模板（单次 LLM 调用完成分析+生成）
   */
  async analyze(session: RecordingSession): Promise<AutomationTemplate> {
    // 1. 提取数据流
    const dataFlow = this.extractDataFlow(session.events);

    // 2. 如果配置了 LLM，一次性完成分析+生成
    if (this.modelService && this.provider && this.apiKey) {
      try {
        console.log('[UnifiedAnalyzer] Starting LLM analysis...');
        const start = Date.now();
        const result = await this.analyzeAndGenerateWithLLM(session, dataFlow);
        console.log(`[UnifiedAnalyzer] LLM analysis completed in ${Date.now() - start}ms`);
        return result;
      } catch (error) {
        console.warn('[UnifiedAnalyzer] LLM analysis failed, using local fallback:', error);
      }
    } else {
      console.warn('[UnifiedAnalyzer] LLM not configured, using local analysis');
    }

    // 3. 本地回退
    const pattern = this.detectPatternLocally(session, dataFlow);
    return this.generateTemplateLocally(session, pattern, dataFlow);
  }

  // ── 数据流提取 ──

  /**
   * 从事件序列中提取数据流
   */
  extractDataFlow(events: SemanticEvent[]): DataFlow | null {
    // 查找复制操作
    const copyEvents = events.filter(e => this.isCopyAction(e.action));

    // 查找粘贴操作
    const pasteEvents = events.filter(e => this.isPasteAction(e.action));

    if (copyEvents.length === 0 || pasteEvents.length === 0) {
      return null;
    }

    // 分析复制源
    const sources = copyEvents.map(e => this.analyzeDataSource(e));

    // 分析粘贴目标
    const targets = pasteEvents.map(e => this.analyzeDataTarget(e));

    // 识别字段映射
    const mapping = this.inferFieldMapping(sources, targets, copyEvents, pasteEvents);

    return {
      source: this.mergeSources(sources),
      target: this.mergeTargets(targets),
      mapping,
    };
  }

  private isCopyAction(action: UnifiedAction): boolean {
    return (
      action.type === 'copy' ||
      (action.type === 'hotkey' && (action.params?.key === 'Ctrl+c' || action.params?.key === 'Ctrl+C'))
    );
  }

  private isPasteAction(action: UnifiedAction): boolean {
    return (
      action.type === 'paste' ||
      (action.type === 'hotkey' && (action.params?.key === 'Ctrl+v' || action.params?.key === 'Ctrl+V'))
    );
  }

  private analyzeDataSource(event: SemanticEvent): DataSource {
    const element = event.element;

    if (element?.structure?.container) {
      const container = element.structure.container;

      // 表格数据源
      if (container.role === 'table' || container.role === 'grid') {
        return {
          type: 'table',
          location: {
            semantic: {
              role: container.role,
              name: container.name || '',
            },
          },
          fields: (container.columns || []).map(col => ({
            name: col,
            type: 'text' as const,
          })),
        };
      }

      // 列表数据源
      if (container.role === 'list') {
        return {
          type: 'list',
          location: {
            semantic: {
              role: container.role,
              name: container.name || '',
            },
          },
          fields: [{ name: 'item', type: 'text' as const }],
        };
      }
    }

    // 通用数据源
    return {
      type: 'custom',
      location: event.action.target || {},
      fields: [{ name: 'value', type: 'text' as const }],
    };
  }

  private analyzeDataTarget(event: SemanticEvent): DataTarget {
    const element = event.element;

    if (element?.structure?.container) {
      const container = element.structure.container;

      // 表格数据目标
      if (container.role === 'table' || container.role === 'grid') {
        return {
          type: 'table',
          location: {
            semantic: {
              role: container.role,
              name: container.name || '',
            },
          },
          fields: (container.columns || []).map(col => ({
            name: col,
            type: 'text' as const,
          })),
        };
      }
    }

    // 通用数据目标
    return {
      type: 'custom',
      location: event.action.target || {},
      fields: [{ name: 'value', type: 'text' as const }],
    };
  }

  private inferFieldMapping(
    sources: DataSource[],
    targets: DataTarget[],
    copyEvents: SemanticEvent[],
    pasteEvents: SemanticEvent[],
  ): FieldMapping[] {
    const mapping: FieldMapping[] = [];

    // 简单情况：一对一映射
    if (sources.length === 1 && targets.length === 1) {
      const sourceFields = sources[0].fields;
      const targetFields = targets[0].fields;

      for (let i = 0; i < Math.min(sourceFields.length, targetFields.length); i++) {
        mapping.push({
          source: sourceFields[i].name,
          target: targetFields[i].name,
        });
      }
    }

    // 复杂情况：根据复制/粘贴的顺序推断
    if (mapping.length === 0 && copyEvents.length === pasteEvents.length) {
      for (let i = 0; i < copyEvents.length; i++) {
        const sourceName = copyEvents[i].element?.identity.name || `field_${i}`;
        const targetName = pasteEvents[i].element?.identity.name || `field_${i}`;

        mapping.push({
          source: sourceName,
          target: targetName,
        });
      }
    }

    return mapping;
  }

  private mergeSources(sources: DataSource[]): DataSource {
    if (sources.length === 0) {
      return {
        type: 'custom',
        location: {},
        fields: [],
      };
    }

    // 合并所有源的字段
    const allFields: DataField[] = [];
    const seen = new Set<string>();

    for (const source of sources) {
      for (const field of source.fields) {
        if (!seen.has(field.name)) {
          seen.add(field.name);
          allFields.push(field);
        }
      }
    }

    return {
      type: sources[0].type,
      location: sources[0].location,
      fields: allFields,
    };
  }

  private mergeTargets(targets: DataTarget[]): DataTarget {
    if (targets.length === 0) {
      return {
        type: 'custom',
        location: {},
        fields: [],
      };
    }

    // 合并所有目标的字段
    const allFields: DataField[] = [];
    const seen = new Set<string>();

    for (const target of targets) {
      for (const field of target.fields) {
        if (!seen.has(field.name)) {
          seen.add(field.name);
          allFields.push(field);
        }
      }
    }

    return {
      type: targets[0].type,
      location: targets[0].location,
      fields: allFields,
    };
  }

  // ── 模式检测（本地） ──

  private detectPatternLocally(
    session: RecordingSession,
    dataFlow: DataFlow | null,
  ): DetectedPattern {
    const events = session.events;

    // 检测循环模式
    const loopPattern = this.detectLoopPattern(events);
    if (loopPattern) {
      return loopPattern;
    }

    // 检测数据流模式
    if (dataFlow) {
      return {
        type: 'loop',
        confidence: 0.7,
        description: `从 ${dataFlow.source.type} 复制数据到 ${dataFlow.target.type}`,
        dataFlow,
      };
    }

    // 线性模式
    return {
      type: 'linear',
      confidence: 0.9,
      description: `执行 ${events.length} 个操作`,
    };
  }

  private detectLoopPattern(events: SemanticEvent[]): DetectedPattern | null {
    if (events.length < 4) {
      return null;
    }

    // 过滤掉无意义的中间事件（如 hotkey 后的 key_up）
    const significant = events.filter(e => {
      if (e.action.type === 'key_up') return false;
      return true;
    });

    if (significant.length < 4) return null;

    // 基于窗口切换检测跨应用循环模式
    const crossAppPattern = this.detectCrossAppLoop(significant);
    if (crossAppPattern) return crossAppPattern;

    // 查找重复的操作序列（基于操作类型，不要求元素完全一致）
    const sequenceLength = this.findRepeatingSequence(significant);
    if (sequenceLength === 0) {
      return null;
    }

    const loopCount = Math.floor(significant.length / sequenceLength);
    const loopBody = significant.slice(0, sequenceLength);
    const loopVariable = this.identifyLoopVariable(loopBody);

    return {
      type: 'loop',
      confidence: 0.8,
      description: `循环 ${loopCount} 次，每次执行 ${sequenceLength} 个操作`,
      loopVariable: loopVariable || 'item',
      loopBody,
    };
  }

  /** 检测跨应用循环模式：在不同窗口间来回切换的重复操作 */
  private detectCrossAppLoop(events: SemanticEvent[]): DetectedPattern | null {
    // 统计每个窗口的操作数
    const windowCounts = new Map<string, number>();
    for (const e of events) {
      const title = e.context?.windowTitle || '';
      if (title) windowCounts.set(title, (windowCounts.get(title) || 0) + 1);
    }

    // 需要至少 2 个不同窗口
    if (windowCounts.size < 2) return null;

    // 检测窗口切换模式：A→B→A→B 或 A→B→C→A→B→C
    const windowSeq = events.map(e => e.context?.windowTitle || '').filter(Boolean);
    const patternLen = this.findWindowSwitchPattern(windowSeq);
    if (patternLen === 0) return null;

    const loopCount = Math.floor(events.length / patternLen);
    if (loopCount < 2) return null;

    const loopBody = events.slice(0, patternLen);
    const windows = [...new Set(windowSeq.slice(0, patternLen))];

    return {
      type: 'loop',
      confidence: 0.85,
      description: `跨应用循环 ${loopCount} 次，涉及窗口: ${windows.join(' → ')}`,
      loopVariable: 'item',
      loopBody,
    };
  }

  /** 检测窗口切换的重复模式长度 */
  private findWindowSwitchPattern(windowSeq: string[]): number {
    for (let len = 2; len <= Math.floor(windowSeq.length / 2); len++) {
      const first = windowSeq.slice(0, len);
      let matches = true;
      for (let i = len; i < windowSeq.length; i += len) {
        const chunk = windowSeq.slice(i, i + len);
        if (chunk.length !== len) continue;
        // 允许部分匹配（至少窗口切换的主模式一致）
        let matchCount = 0;
        for (let j = 0; j < len; j++) {
          if (first[j] === chunk[j]) matchCount++;
        }
        if (matchCount < len * 0.6) { matches = false; break; }
      }
      if (matches) return len;
    }
    return 0;
  }

  private findRepeatingSequence(events: SemanticEvent[]): number {
    for (let len = 2; len <= Math.floor(events.length / 2); len++) {
      if (this.isRepeatingSequence(events, len)) {
        return len;
      }
    }
    return 0;
  }

  private isRepeatingSequence(events: SemanticEvent[], sequenceLength: number): boolean {
    const sequence = events.slice(0, sequenceLength);

    for (let i = sequenceLength; i < events.length; i += sequenceLength) {
      const chunk = events.slice(i, i + sequenceLength);
      if (chunk.length !== sequenceLength) continue;

      for (let j = 0; j < sequenceLength; j++) {
        if (sequence[j].action.type !== chunk[j].action.type) {
          return false;
        }
      }
    }
    return true;
  }

  private identifyLoopVariable(events: SemanticEvent[]): string | null {
    // 查找在循环中变化的元素
    for (const event of events) {
      if (event.element?.structure?.container) {
        const container = event.element.structure.container;

        if (container.role === 'table' || container.role === 'grid') {
          return 'row';
        }

        if (container.role === 'list') {
          return 'item';
        }
      }
    }

    return null;
  }

  // ── 模板生成（本地） ──

  private generateTemplateLocally(
    session: RecordingSession,
    pattern: DetectedPattern,
    dataFlow: DataFlow | null,
  ): AutomationTemplate {
    const events = session.events;
    const steps: TemplateStep[] = [];

    // 如果是循环模式，添加循环开始
    if (pattern.type === 'loop' && pattern.loopBody) {
      steps.push({
        id: 'loop_start',
        action: 'loop_start',
        description: '开始循环',
        params: {
          over: pattern.loopSource || '{{items}}',
          variable: pattern.loopVariable || 'item',
        },
        control: {
          type: 'loop',
          over: pattern.loopSource || '{{items}}',
          variable: pattern.loopVariable || 'item',
          body: [],
        },
      });

      // 添加循环体
      for (let i = 0; i < pattern.loopBody.length; i++) {
        const event = pattern.loopBody[i];
        const waitBefore = i > 0 ? event.timestamp - pattern.loopBody[i - 1].timestamp : 0;
        steps.push({
          id: `loop_step_${i}`,
          action: event.action.type,
          description: this.getEventDescription(event),
          target: this.buildActionTarget(event),
          waitBefore: waitBefore > 100 ? waitBefore : undefined,
          params: event.action.params,
        });
      }

      // 添加循环结束
      steps.push({
        id: 'loop_end',
        action: 'loop_end',
        description: '结束循环',
        control: {
          type: 'break',
        },
      });
    } else {
      // 线性模式，直接添加所有事件
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const waitBefore = i > 0 ? event.timestamp - events[i - 1].timestamp : 0;
        steps.push({
          id: `step_${i}`,
          action: event.action.type,
          description: this.getEventDescription(event),
          target: this.buildActionTarget(event),
          waitBefore: waitBefore > 100 ? waitBefore : undefined,
          params: event.action.params,
        });
      }
    }

    // 构建参数
    const parameters: TemplateParameter[] = [];

    if (dataFlow) {
      parameters.push({
        name: 'source',
        description: '数据源',
        type: 'element',
        required: true,
      });

      parameters.push({
        name: 'target',
        description: '数据目标',
        type: 'element',
        required: true,
      });
    }

    return {
      id: crypto.randomUUID(),
      name: session.metadata.userDescription || 'Recorded Template',
      description: pattern.description,
      version: '1.0.0',
      dataFlow: dataFlow || undefined,
      parameters,
      steps,
      createdAt: Date.now(),
      sourceSession: session.id,
    };
  }

  private getEventDescription(event: SemanticEvent): string {
    const { action, element } = event;
    const elementName = element?.identity.name ? ` "${element.identity.name}"` : '';

    switch (action.type) {
      case 'click':
        return `点击${elementName}`;
      case 'double_click':
        return `双击${elementName}`;
      case 'right_click':
        return `右键点击${elementName}`;
      case 'type':
        return `输入 "${action.params?.text}"`;
      case 'key':
      case 'hotkey':
        return `按键 ${action.params?.key}`;
      case 'copy':
        return '复制';
      case 'paste':
        return '粘贴';
      case 'focus':
        return `聚焦${elementName}`;
      case 'scroll':
        return `滚动 ${action.params?.direction}`;
      case 'drag':
        return `拖动 (${action.params?.start_x},${action.params?.start_y}) → (${action.params?.end_x},${action.params?.end_y})`;
      default:
        return action.type;
    }
  }

  private buildActionTarget(event: SemanticEvent): TemplateStep['target'] {
    const target: TemplateStep['target'] = {};

    // 语义目标
    if (event.element) {
      target.semantic = {
        role: event.element.identity.role,
        name: event.element.identity.name,
      };
    }

    // 坐标目标
    if (event.action.target?.coordinate) {
      target.coordinate = {
        x: event.action.target.coordinate.x,
        y: event.action.target.coordinate.y,
      };
    }

    // 路径目标
    if (event.element?.location.precisePath) {
      target.path = event.element.location.precisePath;
    }

    return target;
  }

  // ── LLM 调用 ──

  private describeTarget(target?: UnifiedAction['target'], params?: Record<string, unknown>): string {
    if (!target) return '';
    if (target.semantic) return `[${target.semantic.role}] "${target.semantic.name}"`;
    if (target.path) return `path: ${target.path}`;
    // Drag: show start → end
    if (params?.start_x !== undefined) {
      return `(${params.start_x},${params.start_y}) → (${params.end_x},${params.end_y})`;
    }
    if (target.coordinate) return `(${target.coordinate.x}, ${target.coordinate.y})`;
    return '';
  }

  private async callLLM(prompt: string, timeoutMs = 600000): Promise<string> {
    if (!this.modelService || !this.provider || !this.apiKey) {
      throw new Error('LLM not configured');
    }

    const stream = this.modelService.chatStream({
      scenario: ModelScenario.recorderAnalysis,
      messages: [{ role: 'user', content: prompt }],
      provider: this.provider,
      apiKey: this.apiKey,
    });

    let result = '';
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(new Error(`LLM request timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
    });

    try {
      const streamIter = (async function* () {
        for await (const chunk of stream) {
          if (chunk.startsWith('__ERROR__:')) {
            throw new Error(chunk.substring(10));
          }
          if (chunk.startsWith('__REASONING__:')) {
            continue;
          }
          yield chunk;
        }
      })();

      // Race: stream consumption vs timeout
      const consume = async () => {
        for await (const chunk of streamIter) {
          result += chunk;
        }
      };

      await Promise.race([consume(), timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (timedOut) {
      throw new Error(`LLM request timed out after ${timeoutMs / 1000}s`);
    }

    return result;
  }

  /**
   * 逐字符修复 LLM 返回的 JSON 中未转义的双引号
   * 处理如 "在 "WPS" 窗口中" 这种字符串值内部的未转义引号
   */
  private fixUnescapedQuotes(jsonStr: string): string {
    let result = '';
    let inString = false;
    let i = 0;

    while (i < jsonStr.length) {
      const ch = jsonStr[i];

      if (ch === '\\' && inString) {
        // 已转义字符，原样保留两个字符
        result += ch;
        i++;
        if (i < jsonStr.length) {
          result += jsonStr[i];
          i++;
        }
        continue;
      }

      if (ch === '"') {
        if (!inString) {
          // 进入字符串
          inString = true;
          result += ch;
        } else {
          // 在字符串中遇到引号——判断是结束引号还是内容中的引号
          // 结束引号特征：后面紧跟 , : ] } 或空白（JSON 结构字符）
          const next = i + 1 < jsonStr.length ? jsonStr[i + 1] : '';
          if (next === '' || next === ',' || next === ':' || next === ']' || next === '}' || next === '\n' || next === '\r' || next === ' ' || next === '\t') {
            // 是结束引号
            inString = false;
            result += ch;
          } else {
            // 是内容中的未转义引号，转义它
            result += '\\"';
          }
        }
      } else {
        result += ch;
      }
      i++;
    }

    return result;
  }

  private parseLLMResponse(response: string): LLMAnalysisResult {
    const trimmed = response.trim();

    // 提取 JSON 内容（支持代码块或裸 JSON）
    let jsonStr = '';
    const fenceStart = trimmed.indexOf('```');
    if (fenceStart !== -1) {
      const contentStart = trimmed.indexOf('\n', fenceStart);
      if (contentStart !== -1) {
        const fenceEnd = trimmed.indexOf('```', contentStart);
        if (fenceEnd !== -1) {
          jsonStr = trimmed.substring(contentStart + 1, fenceEnd).trim();
        }
      }
    }
    if (!jsonStr) {
      // 没有代码块，尝试直接找 { ... }
      const braceMatch = trimmed.match(/\{[\s\S]*\}/);
      if (braceMatch) jsonStr = braceMatch[0];
    }
    if (!jsonStr) jsonStr = trimmed;

    // 第 1 次尝试：直接解析
    try {
      return JSON.parse(jsonStr);
    } catch { /* 第1次 JSON.parse 失败，尝试修复引号 */ }

    // 第 2 次尝试：修复未转义的引号后解析
    try {
      const fixed = this.fixUnescapedQuotes(jsonStr);
      return JSON.parse(fixed);
    } catch { /* 第2次 JSON.parse 失败 (修复后) */ }

    // 第 3 次尝试：正则提取
    const jsonBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (jsonBlockMatch) {
      try {
        return JSON.parse(jsonBlockMatch[1].trim());
      } catch { /* 第3次 JSON.parse 失败 (regex) */ }
    }

    // 最终失败
    console.error('[UnifiedAnalyzer] LLM 返回的完整内容:\n', response);
    throw new Error('Failed to parse LLM response as JSON');
  }

  // ── 坐标模式检测 ──

  /**
   * 从事件序列中检测坐标规律（线性递增/固定值）
   */
  private detectCoordinatePatterns(events: SemanticEvent[]): Map<string, CoordinatePattern> {
    const patterns = new Map<string, CoordinatePattern>();

    // 按 action type + window 分组
    const groups = new Map<string, SemanticEvent[]>();
    for (const e of events) {
      const coord = e.action.target?.coordinate;
      if (!coord) continue;
      const window = e.context?.windowTitle || '';
      const key = `${e.action.type}@${window}`;
      const arr = groups.get(key) || [];
      arr.push(e);
      groups.set(key, arr);
    }

    for (const [key, groupEvents] of groups) {
      if (groupEvents.length < 3) continue;

      const coords = groupEvents.map(e => ({
        x: e.action.target!.coordinate!.x,
        y: e.action.target!.coordinate!.y,
      }));

      const xValues = coords.map(c => c.x);
      const yValues = coords.map(c => c.y);

      // x 方向分析
      let xPattern: { base: number; step: number } | null = null;
      const xVar = variance(xValues);
      if (xVar < 225) { // std < 15px
        xPattern = { base: median(xValues), step: 0 };
      } else {
        const xDiffs = diffs(xValues);
        const xDiffVar = variance(xDiffs);
        if (xDiffVar < 100) { // step std < 10px
          xPattern = { base: xValues[0], step: median(xDiffs) };
        }
      }

      // y 方向分析
      let yPattern: { base: number; step: number } | null = null;
      const yVar = variance(yValues);
      if (yVar < 225) {
        yPattern = { base: median(yValues), step: 0 };
      } else {
        const yDiffs = diffs(yValues);
        const yDiffVar = variance(yDiffs);
        if (yDiffVar < 400) { // step std < 20px
          yPattern = { base: yValues[0], step: median(yDiffs) };
        }
      }

      if (xPattern || yPattern) {
        patterns.set(key, {
          groupKey: key,
          x: xPattern || { base: median(xValues), step: 0 },
          y: yPattern || { base: median(yValues), step: 0 },
          samples: coords,
        });
      }
    }

    return patterns;
  }

  /**
   * 构建坐标模式的 prompt 摘要
   */
  private buildCoordinatePatternsSummary(patterns: Map<string, CoordinatePattern>): string {
    if (patterns.size === 0) return '';

    const lines: string[] = [];
    for (const [, p] of patterns) {
      const xDesc = p.x.step !== 0
        ? `x = ${p.x.base} + index * ${p.x.step}`
        : `x ≈ ${p.x.base} (固定)`;
      const yDesc = p.y.step !== 0
        ? `y = ${p.y.base} + index * ${p.y.step}`
        : `y ≈ ${p.y.base} (固定)`;

      lines.push(`- ${p.groupKey}: ${p.samples.length} 个采样点 → ${xDesc}, ${yDesc}`);
    }

    return `\n### 坐标规律检测（来自录制分析）

${lines.join('\n')}

说明：以上坐标存在明显的线性规律（人手操作有 ±5-15px 的抖动，已取中位数修正）。模板中必须使用循环 + 坐标公式来泛化，不要硬编码每次操作的具体坐标。
`;
  }
}

/**
 * 坐标模式 — 从同类操作的坐标序列中提取的数学规律
 */
interface CoordinatePattern {
  /** 分组标识（action type + window） */
  groupKey: string;
  /** x 轴规律 */
  x: { base: number; step: number };
  /** y 轴规律 */
  y: { base: number; step: number };
  /** 原始坐标样本 */
  samples: Array<{ x: number; y: number }>;
}

// ── 工具函数 ──

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function variance(values: number[]): number {
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  return values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
}

function diffs(values: number[]): number[] {
  const result: number[] = [];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] - values[i - 1]);
  }
  return result;
}

// 导出单例
export const unifiedAnalyzer = new UnifiedAnalyzer();
