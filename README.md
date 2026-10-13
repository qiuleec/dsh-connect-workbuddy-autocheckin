<p align="center">
  <b>自动领取 WorkBuddy 国内版每日签到奖励</b><br>
  <sub>Automatically claim the WorkBuddy CN daily check-in reward</sub>
</p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="#安装">安装</a> ·
  <a href="#配置">配置</a> ·
  <a href="#命令行">命令行</a> ·
  <a href="#已知限制">已知限制</a>
</p>

---

# dsh-connect-workbuddy-autocheckin

自动领取 **WorkBuddy 国内版每日签到奖励**，每天一次，覆盖本机所有已登录账号 —— 无需手动点击。

这是 [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy) 的无界面配套插件。

## 为什么做成独立插件

`dsh-connect-workbuddy` 是第三方插件，更新频繁。两种做法被否决：

| 做法 | 为什么不选 |
| --- | --- |
| 直接改它的 `lib/` | 下次 `pnpm update` 就被覆盖 |
| Fork 一份 | 从此每次上游发版都要手动合并 |

本插件改为**导入原插件的公开导出**，只补上原插件有意留给用户自己做的事：定时调度。上游可以自由演化 —— 只有当它明确导出的那几个成员消失时本插件才会失效，而那时它会给出可读的提示，而不是一堆堆栈（见 `src/base.ts`）。

## 复用与新增

**复用原插件**（本插件不重复实现）：

- 各平台认证文件定位（macOS / Windows / Linux）
- 通过已安装的 App 解密 `$wbEncrypted` 凭据
- Token 刷新
- 两个计费端点：
  - 状态：`POST {billingBase}/v2/billing/meter/checkin-activity-status`
  - 领取：`POST {billingBase}/v2/billing/meter/daily-checkin`

**本插件新增**：

- 每日定时器，以及「每本地自然日一次」的守卫
- 多账号遍历（逐账号用 `credentialFor`，绝不用 `resolve`，因此**不会**悄悄切换正在承载你实时流量的账号）
- 一个命令行，用来在不等定时器的情况下验证

## 安装

需要同一 profile 内已安装 `dsh-connect-workbuddy` **>= 3.0.0**。本插件自身不提供模型能力。

```sh
dsh plugin --profile desktop add github:qiuleec/dsh-connect-workbuddy-autocheckin
```

然后打开 **设置 → 插件 → dsh-connect-workbuddy-autocheckin**，把 **enabled** 打开。

**默认关闭**：这是两个插件里唯一会在无人操作的情况下真实发放奖励的功能，所以必须由你主动开启。

> 建议首次先跑 `status --json`（只读，不发放任何奖励），确认链路通了再打开开关。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 总开关。关闭时不会创建任何定时器。 |
| `authFile` | *(平台默认)* | 指定 WorkBuddy 认证文件，一般不需要。 |
| `accountIds` | `[]` | 要签到的账号。**留空 = 本机所有账号。** |
| `checkOnStart` | `true` | 启动时也领取一次，让短时间运行的会话也能覆盖当天。 |

`accountIds` 的语义与原插件的账号池**正好相反** —— 在原插件里留空表示「谁都不管」。因为在那里，「是否在池中」是花费积分这一动作的开关；而在这里，插件自身的 `enabled` 就是 opt-in，所以用户打开开关、其他什么都不配，也应该得到他想要的行为。

## 时间安排

| | |
| --- | --- |
| 首次执行 | 挂载后 30 秒 |
| 执行间隔 | 每小时 |
| 守卫 | 每个本地自然日最多**自动**执行一次 |

间隔取每小时而非 24 小时是刻意的。真正的约束是那个「每日一次」守卫，而每小时检查意味着：机器在预期时刻休眠，唤醒后很快也能补上；夏令时导致本地午夜偏移时，也不会漏掉一整天。

日期的 key 用**本地** getter 构造，而不是 `toISOString()`：后者在 UTC+8 会在早上 8 点前返回「昨天」，从而把一个尚未开始的日期标记成「已处理」，直接跳过真正的签到。

## 命令行

```sh
# 只读：显示每个账号今天的状态。绝不领取。
dsh plugin --profile desktop exec dsh-connect-workbuddy-autocheckin status

# 立即领取，绕过每日守卫（手动执行即代表你的意图）。
dsh plugin --profile desktop exec dsh-connect-workbuddy-autocheckin checkin

# 检查原插件是否可解析。
dsh plugin --profile desktop exec dsh-connect-workbuddy-autocheckin doctor
```

三个命令都支持 `--json`，以及 `--auth-file <路径>` 和可重复的 `--account <id>`。

**推荐首次执行 `status --json`** —— 它完整走一遍认证发现 → 解密 → 状态端点的链路，但**不发放任何奖励**，你可以在让定时器开始领取之前，先在自己机器上确认接口契约。

## 失败时的行为

- **单个账号**失败会记录在该账号所在行，本轮继续。一个坏账号不会掩盖其他账号的状态。
- `active: false` 报告为 **`inactive`**，而不是 `failed` —— 奖励活动未开启是一种状态，不是值得重试的错误。
- `todayCheckedIn: true` 报告为 **`already`**，且不发领取请求。上游才是「今天」的权威，所以在手机 App 或另一台机器上完成的签到绝不会被重复领取。
- 原插件缺失时记一条日志，而不是崩溃。

## 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 成功（`status` 为只读，恒为 0） |
| `1` | 原插件不可用，或至少一个账号失败 |

## 开发

```sh
pnpm install
pnpm run check     # 类型检查 + 测试 + 构建
```

测试注入了时钟、定时器和整个 Host 接口，因此测试套件不触碰网络、认证文件或真实定时器。

## 已知限制

- **仅限国内版。** 只有国内版 App 有签到奖励；国际版（`workbuddy.ai`）没有对应功能，本插件不涉及。
- **按名称依赖原插件的内部结构。** 若 `WorkBuddyCredentialStore` 或 `WorkBuddyUpstreamClient` 被改名，本插件需要同步更新；`doctor` 会明确指出。
- **上游接口是非官方的。** 与原插件一样，这里依赖 WorkBuddy 面向前端 App 的接口，可能随时变化。

## 免责声明

本插件仅供个人学习与研究使用，用于自动完成你自己账号的日常签到。请遵守 WorkBuddy 的服务条款；因使用本插件产生的任何后果由使用者自行承担。

本项目与腾讯、WorkBuddy、DeepSeek 均无关联。

## 许可证

MIT
