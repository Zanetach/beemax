/**
 * Returns true only for an explicit instruction not to delegate work.
 * Generic words such as "independent" and mere references to Sub-Agents are
 * intentionally insufficient: they also occur in verification requirements
 * and in instructions that permit Sub-Agent execution under parent review.
 */
export function explicitlyForbidsDelegation(text: string): boolean {
	const chinese = /(?:不|不要|不得|无需|不必|禁止|严禁)(?:再)?\s*(?:(?:启用|使用|创建|新建|启动|调用|安排|委派|分派|转派)\s*)?(?:任何|任意|其他|其它)?\s*(?:委派|分派|转派|子代理|子智能体|子任务|子\s*agent)/iu;
	const english = /\b(?:(?:do\s+not|don't|must\s+not|never|without|no\s+need\s+to)\s+(?:(?:use|create|start|spawn|invoke|enable|delegate(?:\s+to)?)\s+)?|no\s+)(?:delegation|delegates?|sub[\s-]?agents?|subtasks?|child\s+agents?|worker\s+agents?)\b/iu;
	return chinese.test(text) || english.test(text);
}
