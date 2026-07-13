# page-pilot

**中文** · [English](./README.md)

**版本 1.2.0** · 完整版本历史见 [CHANGELOG.md](./CHANGELOG.md)

一套不依赖任何第三方库、用于"可视化"浏览器自动化的工具集，分五层，全部放在这一个仓库里：

| 层 | 文件 | 做什么 |
|---|---|---|
| **核心** | `src/page-pilot.js` | 带着能看见的动画光标、点击涟漪、高亮框去回放一组步骤——让人一眼就能看清正在做什么、做在哪 |
| **录制器** | `src/page-pilot-recorder.js` | 把真实的点击/打字/选择，转换成核心引擎能直接理解的步骤数组 |
| **技能** | `src/page-pilot-skills.js` | 把一次录制变成可复用、命名好的"技能"——具体的值变成命名好的参数，以后可以换着用 |
| **工具包** | `src/toolkit.js` | 一个书签：拖一个链接到收藏夹栏，在任意网站点一下就能弹出录制/运行面板——不需要安装，不需要扩展 |
| **Agent**（预览版）| `src/page-pilot-agent.js` + `extension/` | 一个 Chrome 插件：给一句指令 + 一个参考技能，AI 根据页面实际状态一步步决定下一步怎么做——详见下面 [Agent](#agent预览版) 部分 |

每一层只依赖表格里排在它前面的层——核心引擎完全没有依赖，录制器只是生成核心引擎能理解的步骤，技能层除了 DOM 之外什么都不依赖，工具包把前三层拼在一起、套一层界面，Agent 跑在核心引擎之上，可以选配一个技能当参考。每一层都可以单独拿出来用。

## 快速开始——完全不用写代码

**[打开安装页面](https://jyy1082.github.io/page-pilot/demo/install.html)**，把上面那个按钮拖到收藏夹栏。在任意网站点一下，就能录制一段点击/打字操作、存成可复用的技能，或者直接粘贴一段步骤 JSON 运行——具体见下面"工具包"部分。

## 快速开始——当作库来用

```bash
npm install page-pilot
```

```js
import { PagePilot } from 'page-pilot'
import { PagePilotRecorder } from 'page-pilot/recorder'
import { detectParameters, saveSkill, fillSkillParameters } from 'page-pilot/skills'

const recorder = new PagePilotRecorder()
recorder.start()
// ...正常操作页面...
const steps = recorder.stop()

const cursor = new PagePilot()
await cursor.run(steps) // 带着能看见的光标回放
```

---

# 核心：page-pilot（回放）

带着能看见的光标、点击动画、持续显示的高亮框去回放一组步骤。它**不会**自己决定点什么——只负责把你（或者录制器、或者技能层）已经确定好要做的动作，做出动画并真正执行，自动化的实际逻辑始终在你手里。

## 用法

```js
import { PagePilot } from 'page-pilot'

const cursor = new PagePilot()
await cursor.click(document.querySelector('#submit'))
await cursor.type(document.querySelector('#name'), 'Acme Corp')
await cursor.select(document.querySelector('#country'), 'US')
await cursor.check(document.querySelector('#agree'), true)
await cursor.chooseOption('#menu-trigger', '.menu-item[data-value="pro"]')
await cursor.pressKey('#search', 'Enter')
await cursor.hover('#info-icon')
await cursor.unhover()
await cursor.dragTo('#item-1', '#drop-zone')
await cursor.waitFor('#async-result', { timeout: 8000 })
await cursor.waitFor('#save-btn', { state: 'gone', timeout: 3000 }) // 等一个东西消失，而不是出现
await cursor.waitForFrameReload('#payment-iframe') // 等一个同源 iframe 重新加载
cursor.destroy()
```

或者一次跑完整段录制/手写的步骤：

```js
await cursor.run([
  { type: 'click', target: '#submit' },
  { type: 'type', target: '#name', text: 'Acme Corp' },
])
```

## target 的几种形式

`target` 可以是 `Element`、CSS 选择器字符串，或者一个对象，组合了 `selector` 和：
- **`frame`** —— 同源 iframe 里的元素（一个 iframe 选择器，多层嵌套是数组）。跨域 iframe 完全没法操作——这是浏览器本身的安全限制，绕不过去。
- **`index`** —— 选择器本身匹配到不止一个的时候，指定第几个（真实网站上重复 `id` 相当常见）。
- **`text`** —— 按钮/链接按可见文字匹配（原生 CSS 没有"按文字匹配"这种选择器，这个字段补上这个能力——文字往往是按钮最容易被人认出来的标识）。

这三者可以自由组合，也都能跟 `frame` 一起用。这些正是 page-pilot-recorder 会自动生成的格式，录制出来的步骤不需要手动调整就能直接回放。

## 弹窗和蒙版

因为点击是直接派发给已经解析好的元素，而不是通过浏览器正常的"命中测试"去找的，这个库有可能"穿透"过真实鼠标根本碰不到的东西——最常见的就是一个模态弹窗的蒙版还盖在页面上面。把 `verifyClickable` 设成 `true`，每次点击前都会检查一下，如果被挡住了会直接报一个清楚的错误，说明是被什么挡住的，而不是悄悄穿透过去。提供 `onObstruction: async (blockingEl, targetEl) => boolean` 可以自己处理这种情况（比如把弹窗关掉），而不是直接报错——返回 `true` 表示你已经处理好了（这个回调里要用原生的 `element.click()`，不要用 `cursor.click()`，否则会导致排队队列死锁）。

## iframe 重新加载

如果一次点击导致某个同源 iframe 重新加载了自己的内容（内嵌支付组件、多步骤表单很常见这种情况），`waitForFrameReload(selector)` 会等它的文档对象真的换了一份，完全不需要知道新内容长什么样：

```js
await cursor.click('#refresh-iframe-btn')
await cursor.waitForFrameReload('#payment-iframe')
await cursor.click({ selector: '#new-btn', frame: '#payment-iframe' })
```

或者把 `autoWaitForIframeReload` 设成 `true`，让每次点击都自动做这个检测，不需要手动加等待步骤——适合那些你没法手动改步骤内容的场景（录制/粘贴进来的 JSON、保存好的技能）。

## 配置项（默认值）

```js
new PagePilot({
  color: '#378ADD', size: 16, moveDuration: 480, clickPause: 260, typeDelay: 45,
  respectReducedMotion: true, zIndex: 999999,
  showCursorDot: true, showScrollIndicator: false, showPageGlow: false,
  pageGlowColor: null, pageGlowWidth: 4, pageGlowTarget: null, pageGlowRadius: 0,
  pageGlowMessage: null,          // 显示在呼吸边框区域上方的状态文字
  blockInteraction: true,         // 呼吸边框显示期间，阻止真实鼠标点击这块区域
  pointerBlockAllowlist: [],      // 即使在阻止期间也保持可点击的选择器
  highlightEnabled: true, highlightColor: null, highlightDuration: null,
  autoWaitForIframeReload: false, autoIframeReloadGrace: 400, autoIframeReloadMaxWait: 4000,
  verifyClickable: false, onObstruction: null,
  onExecuteClick: (el) => { /* 派发 pointerdown/mousedown/pointerup/mouseup/click 序列 */ },
  onExecuteInput: (el, text) => { /* 原生 setter 输入 */ },
  onBeforeStep: (step) => {}, onAfterStep: (step) => {},
})
```

## 已知限制

- 原生 `<select>` 下拉菜单、原生日期/颜色选择器——弹出的面板是操作系统/浏览器自己绘制的，不在 DOM 里，所以只有触发点击这个动作能做动画。
- 文件上传框（`<input type="file">`）出于安全原因，任何浏览器的任何脚本都设置不了。
- `dragTo()` 覆盖的是基于鼠标事件的拖拽（自定义排序列表、滑块）——不是原生 HTML5 拖放（`draggable="true"` + `DataTransfer`），大部分浏览器这个需要真实的用户手势。
- 派发的每个事件都是真实的，但 `isTrusted` 都是 `false`——没有任何页面级 JS 能改变这一点。大部分网站不检查 `event.isTrusted`；少数网站（专门做了反自动化检测的）会检查，会悄悄忽略掉。

---

# 录制器：page-pilot-recorder

把真实的点击/打字/选择转换成核心引擎能理解的步骤数组。只监听真实的（`isTrusted`）DOM 事件，自己从不派发任何东西——跟核心引擎正好是镜像关系。

## 用法

```js
import { PagePilotRecorder } from 'page-pilot/recorder'

const recorder = new PagePilotRecorder({ ui: true }) // 浮动的开始/停止/复制面板
recorder.start()
// ...正常操作页面...
const steps = recorder.stop()
```

## 会录制什么

点击、打字（缓冲到失焦才生成一条，不是按键就录——`<textarea>`/`contenteditable` 里的 Enter 就是普通换行，不是什么快捷键，所以多行文字不会在第一行就被截断）、原生 `<select>`（单选/多选）、复选框/单选框（作为 `check` 步骤）、非字符按键和组合键快捷键（Ctrl+A 之类，作为 `pressKey`）、防抖处理过的窗口/容器滚动、超过距离阈值的拖拽手势（会跳过看起来像是选文字的拖拽）、以及打开一个自定义下拉菜单加选一个选项（通过 `MutationObserver` 自动合并成一条 `chooseOption` 步骤，而不是两条独立的点击）。

如果一个字段被打字、离开、又回来重新打字——比如离开又回来改正一个打错的字——只要这两次编辑之间**确实什么都没发生**，只会录下最终的值，中间用来清空/编辑的那些按键（退格、Ctrl+A 之类）也会一并清理掉（不需要留着，合并后的这一条本身回放出来就是同样的最终结果）。但只要中间**真的**发生了别的事情——哪怕只是顺手点了别处一下——两次编辑都会按顺序原样保留成各自独立的步骤，因为这种情况下时间先后关系可能会影响回放是否正确。

**任何网站、任何情况下都不会录制：** 密码框——这是硬性规则，不能配置。

**不会自动录制、需要人自己决定的：** `waitFor()` 步骤（后续步骤上的 `gapBefore` 字段会提示"这里停顿了一下"，可能当时在等什么异步加载）和悬停手势（太难跟"鼠标不小心划过去"可靠区分开）。

## 日期选择器和类似的组件

如果日期字段也支持直接打字输入（大部分都支持——可以先试一下），直接把日期当文字打进去就行,不用点日历弹窗——这样录出来就是一条普普通通的 `type` 步骤，比"精确复现当时点的是日历上哪个月哪一天的哪个格子"要简单、可靠得多。

如果一个字段只能靠点日历选（比如真的设成了 `readonly` 只读），这种情况现在也能正确处理——哪怕有些真实存在的组件（用真实的 bootstrap-datepicker 验证过）在点完某一天之后，是直接给输入框设值、完全不触发任何 `input`/`change` 事件的，本来这种情况完全没有信号能捕捉到。触发这次赋值的那次点击本身也不会被留下来当成一条单独的步骤（它对应的是日历上某个具体的格子，回放的时候日历根本没打开，这个格子压根不存在）——最终只会留下一条干干净净、带着最终日期值的 `type` 步骤，效果跟直接打字进去完全一样。

## 选择器生成策略

每个 target 都是按这个优先级依次尝试：`id`（重复的话按位置区分开来——真实网站上很常见）、`data-testid`/`-cy`/`-test`/`-qa`、其他任意 `data-*` 属性、`aria-label`、`name`、按钮/链接的可见文字内容（重复的话同样按位置区分）、非工具类的 class 名，最后兜底用 `nth-of-type` 结构路径。走到了位置区分或者结构路径兜底的步骤，会带上 `fragile: true` 标记。

同源 iframe 里的操作，会自动带上 `frame` 字段。

## 配置项（默认值）

```js
new PagePilotRecorder({
  ui: true, scrollSettleDelay: 250,
  mergeChooseOption: true, chooseOptionMergeWindow: 4000,
  recordDragTo: true, dragThreshold: 10,
  waitHintThreshold: 1200,
  recordIframes: true,
  onStep: null, onWaitHint: null,
})
```

---

# 技能：page-pilot-skills

把录制到的步骤数组转换成一个可复用的"技能"：一句简短描述、一份命名好的参数列表，以及把具体值替换成 `{{参数名}}` 占位符之后的原始步骤——这样同一段录制内容，换个值就能重新跑一遍。**这里面完全没有 AI**——哪些值该变成参数、叫什么名字、要不要保存，全部是人自己决定和确认；以后要用的时候，也是人自己提供真实的值。检索（根据一句新指令找到对应技能）和自然语言提取参数值，是另外一层、以后再做的事，不属于这一层。

## 用法

```js
import { showArchivePanel, listSkills, fillSkillParameters } from 'page-pilot/skills'

const steps = recorder.stop()
const skill = await showArchivePanel(steps) // 选"仅本次使用"返回 null；否则自动保存好

// 以后，用新的值跑一遍保存好的技能：
const saved = listSkills()[0]
const filledSteps = fillSkillParameters(saved, { '姓氏': 'Tanaka', '部门': 'Engineering' })
await cursor.run(filledSteps)
```

## 什么会被识别成候选参数

每个 `type` 步骤的 `text`、`select` 步骤的 `value`、`check` 步骤的 `checked` 状态，每一个都会按这个顺序尝试给出建议名字：`<label for="...">`、包裹它的 `<label>`、`aria-label`、`placeholder`、最后是 `name`。`select` 的值默认建议勾选；`check` 的状态和超过 200 字符的值默认建议不勾选（通常是流程里固定不变的一部分，或者是自由文本，不太值得重新做成参数）。

`select` 步骤录下来的原始 `value` 往往是一串没有意义的编码（内部 id、性别编号之类），对审查的人来说毫无意义——面板会尽量改成显示实际选中的那个 `<option>` 的可见文字，底层真正用于回放的原始值不受影响，照样保留。

如果好几个步骤最终都指向同一个字段——打了点东西、跳到别的字段、又点回来重新打了别的内容——这是两次真实、独立的编辑,不是 bug，但最终决定这个字段回放时会是什么值的，只有**最后一次**。所以只有最后这一次会变成候选参数；前面那个已经作废的值根本不会出现在列表里，不会有"不小心把已经没用的那个值改成参数、误留下真正生效的那个"这种风险。

## 存下来的是什么，故意不存的又是什么

**示例值永远不会被存下来**——只存参数的**名字**，哪怕草稿对象里顺带带了一个示例值。技能按域名区分（默认用 `location.hostname`）。`fragile` 和 `highRisk`（对照常见危险操作关键词检测——删除/提交/支付/转账，中英文都覆盖——只是预先勾选面板里的复选框，不会强制执行什么）会自动设置，但都不会阻止保存。

## API

| 方法 | 说明 |
|---|---|
| `detectParameters(steps)` | 扫描步骤数组，返回带建议名字的候选参数 |
| `hasFragileSteps(steps)` / `isHighRisk(steps)` | 启发式检查，用来预先填充面板里的提示 |
| `buildSkillDraft(description, steps, acceptedParams)` | 构建一个替换好占位符的草稿 |
| `saveSkill` / `listSkills` / `getSkill` / `deleteSkill` | 基于 `localStorage`、按域名区分的存储 |
| `fillSkillParameters(skill, values)` | 把真实值替换回去，直接可以交给 `cursor.run()` |
| `showArchivePanel(steps, options?)` | 完整的确认界面；自己负责保存，返回保存好的记录或者 `null` |

---

# 工具包：书签

把前面三层拼在一起，套一个浮动面板，通过书签注入——安装链接见最上面的"快速开始"。

## 做了什么

- **Start recording** / **Stop** —— 通过录制器层录制；Stop 之后还会弹出技能归档面板（存成可复用的技能，还是只用这一次——不管选哪个，下面的 JSON 框始终保留**这次录制的原始值**，所以 Run/Copy 立刻就能用）。
- **我的技能** —— 当前网站下保存过的所有技能。**Run** 弹一个小表单，每个参数一个输入框；高风险技能运行前多一步确认；**Delete** 删除一个，删之前会先确认。
- **Run** / **Copy** —— 跑框里的 JSON（录制的、粘贴的、手写的都行——不一定要先录制），或者复制出去。
- 自动处理"某一步导致某个同源 iframe 重新加载"这种情况（`autoWaitForIframeReload: true`），并且拒绝穿透还开着的弹窗蒙版去点背后的东西（`verifyClickable: true`）——这两个在这里都是默认开启的，因为在这个面板里没有实际可行的方式去手动给录制/粘贴进来的 JSON 加等待步骤。

## 安全性说明

- 你在哪个页面上运行这个书签，它就拥有你浏览器会话在那个页面上本来就有的访问权限——跟任何书签或者用户脚本一样。
- 面板本身渲染在一个封闭的 Shadow DOM 里，宿主页面的 CSS 弄不乱它，它自己的样式也不会泄漏出去影响宿主页面。
- 保存的技能存在那个网站自己的 `localStorage` 里——清空浏览器里这个网站的数据，技能也会一起被清掉。
- 书签的地址锁定了这个仓库的一个具体版本号（见 `demo/install.html`）——想更新就要重新拖一次书签，已经装好的书签会一直保持原来的行为，直到你自己选择更新。
- 有些网站的 Content-Security-Policy 会完全拦截这次注入的外部 `<script>`——出现这种情况书签会弹一个提示。这是网站自己的安全设置，书签没有任何特权能绕过去（浏览器扩展可以）。

---

---

# Agent（预览版）

一个基于核心引擎的 Chrome 插件（Manifest V3）。给一句自然语言指令，加上（可选的）一个参考技能——一段录制好的步骤序列，当成大致的路线图,不是死板照抄的脚本——它会根据页面**实际当前的状态**，一步步决定下一步做什么，而不是提前把整个计划定死。这样万一真实页面跟参考技能录制时不完全一样，也能跟着调整，而不是一条道走到黑。

## 为什么这块必须做成插件，不能沿用书签

书签注入的脚本跟当前页面是绑在一起的——对工具包来说没问题，因为录制和运行技能都发生在同一个页面的生命周期里。但 agent 循环不一样：真实任务的步骤经常会提交表单、跳转链接，导致页面整个刷新或者跳走，这种情况下书签注入的脚本会直接被销毁，没法在任务中途恢复。这个插件把所有任务状态（指令、参考技能、到目前为止发生的历史）都存在后台 service worker 里，按标签页区分——不存在页面本身身上——所以页面跳转之后重新注入的 content script，能从后台那边把同一个任务原样接着往下做。

## 目前进度

循环怎么跑、任务状态怎么管理、页面怎么扫描、AI 返回的结果怎么校验，这些都已经搭好并且测试过了。真正调用模型这一步（`extension/background/background.js`）现在接的是 OpenAI 的 Chat Completions 接口——具体怎么配置见下面"配置模型"。

用真实页面 + 真实的 page-pilot 核心引擎测试过，只是把 `chrome.*` 这部分插件专用 API 模拟掉了——这是开发这个项目的环境里能做到的最强验证了，因为这个环境本身没法真的加载一个完整的 Chrome 插件（具体折腾过程见 CHANGELOG.md 里 1.1.1 那条记录）。真正意义上的端到端确认——让真实的 Chrome 实际加载这个插件——还需要你在自己的真实 Chrome 里完成，见下面"怎么试用"。

## 配置模型

打开 `extension/background/background.js`，把靠近文件开头的 `OPENAI_API_KEY` 改成你自己的真实 key。

```js
const OPENAI_API_KEY = 'YOUR_OPENAI_API_KEY_HERE'; // ← 改成你自己的 key
const OPENAI_MODEL = 'gpt-4o';                     // ← 或者换成其他支持 chat completions 的模型
```

**这只是临时的、仅供本地自己测试的做法**——真实的 API key 硬编码在代码里，除了自己测试之外任何场景都不安全：明文存放，很容易不小心提交进版本控制，泄漏了也没法只吊销某一个人的权限。真正要发布之前，这块必须换成一个正经的设置界面，用 `chrome.storage.local` 存（由使用插件的人自己输入，永远不提交进源代码）——到那时候，其他部分完全不需要改，只需要改这一小块。如果你自己要试：别把你的 key 提交进去，万一不小心提交了，就当这个 key 已经泄漏了，直接去吊销重新生成一个。

请求用的是 OpenAI 最基础的 JSON 模式（`response_format: { type: "json_object" }`），能保证返回的是**语法合法**的 JSON，但不保证一定符合我们需要的具体格式——这正是 `validateDecision()`（在 `src/page-pilot-agent.js` 里）存在的意义，不管返回的内容长什么样，都会先校验一遍再决定要不要信。解析失败或者校验不通过，都会让任务进入"卡住"状态并给出清楚的原因，而不是悄悄重试或者瞎猜。

## 怎么试用

```bash
git clone https://github.com/jyy1082/page-pilot
```

然后在 Chrome 里：打开 `chrome://extensions` → 打开右上角"开发者模式" → 点"加载已解压的扩展程序" → 选中克隆下来的仓库根目录（`manifest.json` 就在这个目录下）。打开插件自带的 service worker 检查器，能看到每个页面加载时 content script 发来的 `PP_AGENT_CONTENT_READY` 消息——哪怕还没接真正的模型，这样也能确认整个链路是通的。

## 测试

```bash
npm install
npm test               # 五层全部跑一遍
npm run test:core      # 只跑某一层
npm run test:recorder
npm run test:skills
npm run test:toolkit
npm run test:agent
npm run test:extension-background
npm run test:extension-content
```

跑的都是真实浏览器测试（Playwright + Chromium，通过 `@sparticuz/chromium` 拿到——它的 npm 包把浏览器二进制文件直接打包在自己的 tarball 里，不需要额外单独下载一步，这在没法访问 Playwright 自己的 CDN 的沙盒环境里很关键）。这个项目一路做下来，真实浏览器测试抓到过好几个用模拟 DOM 环境（jsdom）完全测不出来的 bug——跨 realm 的 `instanceof` 对 iframe 内容失效、`activeElement` 判断范围搞错了文档、`el.click()` 压根不会模拟 `mousedown`，等等——每一个都记录在 [CHANGELOG.md](./CHANGELOG.md) 里对应发现它的那次改动里。

## 协议

MIT
