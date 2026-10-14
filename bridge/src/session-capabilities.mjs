const modes = {
  claude: {
    desktop: ['unsupported', 'NO_DOCUMENTED_INTERFACE', '普通桌面未核实外部创建、续接或目录绑定接口。', 'account_backend', false],
    desktop_cowork: ['documented_file_handoff', 'EXTERNAL_COWORK_CONTROL_UNVERIFIED', 'Cowork 文件交接有官方能力依据；外部会话控制未核实，不等于 Code 模式。', 'cowork_execution_mode_unverified', false],
    code_cli: ['documented', 'ADAPTER_DISABLED', '独立 Claude Code 文本模式，需明确接受产品模式并授权启用。', 'local_cli_records', true],
    agent_sdk: ['documented', 'ADAPTER_NOT_IMPLEMENTED', 'SDK 与桌面上下文独立；本次未安装或启用。', 'local_sdk_records', true],
    messages_api: ['documented', 'NO_PERSISTENT_CONVERSATION', '消息编号不是可续接的平台会话编号；收费 API 未启用。', 'remote_messages', false],
    managed_agents: ['documented', 'REMOTE_MODE_DISABLED', '云端独立会话和身份前提未授权。', 'cloud_sandbox', false]
  },
  workbuddy: {
    desktop: ['unknown', 'CAPABILITY_UNVERIFIED', '桌面入口、身份与请求 cwd 生效未验证。', 'desktop_storage_unverified', false],
    localassistant: ['documented_partial', 'CONVERSATION_BINDING_UNAVAILABLE', '公开接口返回 message_id，未公开目标会话编号和 cwd 绑定。', 'pc_assistant_storage_unverified', false],
    cloud: ['documented', 'LOCAL_DIRECTORY_UNSUPPORTED', '云端 task_id 是真实会话编号；本机目录绑定和应用准入未验收。', 'cloud_sandbox', false],
    codebuddy_http: ['documented', 'PRODUCT_MODE_UNVERIFIED', 'CodeBuddy HTTP Beta 不等于桌面原会话；目录和身份未验收。', 'local_cli_records', false],
    codebuddy_sdk: ['documented', 'PRODUCT_MODE_UNVERIFIED', 'CodeBuddy SDK 会话与桌面上下文映射未核实。', 'local_sdk_records', false]
  },
  doubao: {
    desktop: ['unknown', 'CAPABILITY_UNVERIFIED', '现有 MCP 只验证平台调用外部工具，未核实外部会话控制。', 'desktop_storage_unverified', false],
    openapi: ['unknown', 'CAPABILITY_UNVERIFIED', '官方内测准入，尚未取得正式会话和目录契约。', 'unverified', false],
    local_computer: ['unknown', 'CAPABILITY_UNVERIFIED', '未核实外部会话编号、目录绑定与权限查询契约。', 'local_storage_unverified', false],
    cloud_computer: ['unknown', 'CAPABILITY_UNVERIFIED', '云端存储不等于本机目录，接口及实际位置未核实。', 'cloud_storage_unverified', false]
  }
};

export function sessionCapability(platform, mode, configuration = {}, runtimeVerified = false) {
  const entry = modes[platform]?.[mode];
  const [documentedStatus, baseCode, reason, storageKind, cwdDocumented] = entry ?? ['unknown', 'MODE_UNVERIFIED', '该平台与产品模式未核实，不能自动切换。', 'unverified', false];
  const enabled = platform === 'claude' && mode === 'code_cli' && configuration.enabled === true && configuration.acceptedProductMode === true;
  const disabledReason = platform === 'claude' && mode === 'code_cli' && configuration.acceptedProductMode === true
    ? '已接受独立 Code 文本模式；适配器尚未启用，真实运行与账号权益未验证。' : reason;
  return { platform, mode, documentedStatus, enabled, runtimeVerified: enabled && runtimeVerified,
    conversationId: null, storageKind, authenticationStatus: 'unverified', accountEntitlementStatus: 'unverified', evidenceLevel: runtimeVerified ? 'real_runtime' : 'documentation_only',
    workingDirectory: { documented: cwdDocumented, status: runtimeVerified ? 'runtime_verified' : 'not_runtime_verified', runtimeVerified: enabled && runtimeVerified, evidence: '原生进程 cwd 与 init.cwd 必须独立核对。' },
    fileAccessBoundary: { status: 'unverified', verified: false, evidence: '桥的路径防护和禁用工具不构成整个平台文件隔离。' },
    osIsolation: { status: 'unverified', verified: false },
    productModeAccepted: platform === 'claude' && mode === 'code_cli' ? configuration.acceptedProductMode === true : null,
    disabledCode: enabled ? null : baseCode, disabledReason: enabled ? null : disabledReason,
    textOnly: platform === 'claude' && mode === 'code_cli', automaticRetry: false, automaticRetryScope: 'controller_resubmission_only', cliInternalRetryStatus: 'unknown', automaticModeSwitch: false };
}

export function allSessionCapabilities(configuration = {}, verified = () => false) {
  return Object.entries(modes).flatMap(([platform, entries]) => Object.keys(entries).map(mode => sessionCapability(platform, mode, configuration, verified(platform, mode))));
}
