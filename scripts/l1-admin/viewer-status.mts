// viewer-status.mts —— 查看器版本与漂移诊断（供写盘桥的 /api/viewer-status 调用）
//
// 为什么单独一个 CLI 而不是在桥里重算一遍哈希：
// 桥是 .mjs，不能 import .ts。而"源码内容版本号"的算法**已经在 `memory/viewers/deploy.ts` 里**
// （`scanViewerSource`）—— 桥若照抄一份，公式一改就会出现「明明已部署却一直报漂移」或漏报。
// 这是本次要根治的失效模式本身，所以桥只做转发，算法只有一份。
//
// 输出（stdout JSON）：
//   { sourceVersion, deployedVersion, drifted, sourceRoot, deployedAt, files, retired }
//
// 用法：node --experimental-strip-types scripts/l1-admin/viewer-status.mts [--profile <dir>]
import { argv, stdout } from "node:process";
import { readDeployedManifest, scanViewerSource } from "../../memory/viewers/deploy.ts";

/** 取 `--flag value` 形式的值。 */
function flagValue(flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
}

// 与其它 l1-admin 工具同默认值（桥也是这个默认）
const PROFILE = flagValue("--profile") ?? "C:/Users/leaf/.pi/agent/profiles/default";

const scan = scanViewerSource();
const deployed = readDeployedManifest(PROFILE);

// 一律用 process.exitCode 而非 exit()：stdout 是管道时写入是异步的，立刻 exit 会截断 JSON。
stdout.write(
	`${JSON.stringify(
		{
			sourceVersion: scan.version,
			sourceRoot: scan.sourceDir,
			sourceFiles: scan.files.length,
			deployedVersion: deployed?.version ?? null,
			deployedAt: deployed?.generatedAt ?? null,
			retired: deployed?.retired ?? [],
			// 漂移 = 源码内容版本与已部署版本不一致（源码改了但扩展还没重新部署）
			drifted: !!deployed && !!scan.version && deployed.version !== scan.version,
			// 从未部署过
			neverDeployed: !deployed,
			errors: scan.errors,
		},
		null,
		2,
	)}\n`,
);
process.exitCode = 0;
