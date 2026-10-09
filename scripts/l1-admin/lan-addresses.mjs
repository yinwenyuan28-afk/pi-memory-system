// lan-addresses.mjs —— 本机局域网 IPv4 探测（桥的 `--lan` 与一键启动器共用一份规则）
//
// 为什么独立成文件、而不是各写一份：`--lan` 的语义是"把桥也听在局域网上"，而"哪块网卡算局域网"
// 一旦出现两份规则，就会出现最难查的那种错配 —— 启动器打印的是 A 地址、桥实际听的是 B 地址。
// 桥是 .mjs、启动器是 .mts，两者都能 import 这个 .mjs（反过来不行：.mjs 不能 import .mts）。
//
// 排序（先者优先），基于本机实测的多网卡环境：
//   1. `172.16.10.0/24` —— 用户明确要用它调试的网段（本机 `et_5_sj4t` = 172.16.10.4）
//   2. 其它私有段（10/8、172.16/12、192.168/16）
//   3. 其余非内部 IPv4（兜底：真没有私有地址时也得给个候选，否则 --lan 直接失效）
// 排除：环回（internal）与 IPv6 —— 它们都不是"别的设备能连上"的地址。
import { networkInterfaces } from "node:os";

/** 用户调试用的网段（优先选中）。 */
const PREFERRED_PREFIX = "172.16.10.";

/** 是否私有 IPv4（RFC1918 三段）。 */
function isPrivate(a) {
	const [x, y] = a.split(".").map(Number);
	if (x === 10) return true;
	if (x === 172 && y >= 16 && y <= 31) return true;
	if (x === 192 && y === 168) return true;
	return false;
}

/** 排序权重：越小越优先（0 = 首选网段，1 = 其它私有段，2 = 兜底）。 */
function rank(a) {
	if (a.startsWith(PREFERRED_PREFIX)) return 0;
	return isPrivate(a) ? 1 : 2;
}

/**
 * 本机候选局域网地址，按优先级排序（已去重）。
 *
 * 返回的是**候选列表而不是单个地址**：多网卡机器上（本机有 VPN / 无线 / 有线三张）"该用哪个"
 * 只有人知道，所以调用方要把候选都打印出来，让人能用 `--host <addr>` 钉死其中一个。
 */
export function lanAddresses() {
	const out = [];
	for (const list of Object.values(networkInterfaces())) {
		for (const a of list || []) {
			if (a.family !== "IPv4" || a.internal) continue;
			if (!out.includes(a.address)) out.push(a.address);
		}
	}
	return out.sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
}
