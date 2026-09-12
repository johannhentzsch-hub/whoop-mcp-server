import { Yazio } from 'yazio';

type Daytime = 'breakfast' | 'lunch' | 'dinner' | 'snack';

interface MacroSet {
	kcal: number;
	protein: number;
	carbs: number;
	fat: number;
}

const DAYTIMES: Daytime[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const DAYTIME_LABEL: Record<Daytime, string> = {
	breakfast: 'Frühstück',
	lunch: 'Mittag',
	dinner: 'Abend',
	snack: 'Snacks',
};

function toDate(value: string | undefined): Date {
	if (!value) return new Date();
	// Noon UTC avoids day-boundary drift when the server runs in UTC.
	return new Date(`${value}T12:00:00Z`);
}

function ymd(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function daysBack(count: number): Date[] {
	const out: Date[] = [];
	const today = new Date();
	for (let i = count - 1; i >= 0; i--) {
		const d = new Date(today);
		d.setUTCDate(today.getUTCDate() - i);
		d.setUTCHours(12, 0, 0, 0);
		out.push(d);
	}
	return out;
}

function pct(value: number, goal: number): string {
	if (!goal) return '';
	return ` (${Math.round((value / goal) * 100)} %)`;
}

function r0(n: number): string {
	return Math.round(n).toString();
}

function macrosFrom(n: Record<string, number>): MacroSet {
	return {
		kcal: n['energy.energy'] ?? 0,
		protein: n['nutrient.protein'] ?? 0,
		carbs: n['nutrient.carb'] ?? 0,
		fat: n['nutrient.fat'] ?? 0,
	};
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return results;
}

export class YazioService {
	private client: Yazio;

	constructor(username: string, password: string) {
		this.client = new Yazio({ credentials: { username, password } });
	}

	static fromEnv(): YazioService | null {
		const username = process.env.YAZIO_USERNAME;
		const password = process.env.YAZIO_PASSWORD;
		if (!username || !password) return null;
		return new YazioService(username, password);
	}

	/** Day summary: totals vs. goals, per-meal split, water, steps, consumed items. */
	async getDaySummary(dateStr?: string, includeItems = true): Promise<string> {
		const date = toDate(dateStr);
		const summary = await this.client.user.getDailySummary({ date });

		const goals = macrosFrom(summary.goals as Record<string, number>);
		const total: MacroSet = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
		const perMeal: Record<Daytime, MacroSet> = {} as Record<Daytime, MacroSet>;
		for (const dt of DAYTIMES) {
			const m = macrosFrom(summary.meals[dt].nutrients as Record<string, number>);
			perMeal[dt] = m;
			total.kcal += m.kcal;
			total.protein += m.protein;
			total.carbs += m.carbs;
			total.fat += m.fat;
		}

		let out = `# Ernährung ${ymd(date)} (Yazio)\n\n`;
		out += `## Tagesbilanz\n`;
		out += `- **Kalorien**: ${r0(total.kcal)} / ${r0(goals.kcal)} kcal${pct(total.kcal, goals.kcal)}\n`;
		out += `- **Protein**: ${r0(total.protein)} / ${r0(goals.protein)} g${pct(total.protein, goals.protein)}\n`;
		out += `- **Kohlenhydrate**: ${r0(total.carbs)} / ${r0(goals.carbs)} g${pct(total.carbs, goals.carbs)}\n`;
		out += `- **Fett**: ${r0(total.fat)} / ${r0(goals.fat)} g${pct(total.fat, goals.fat)}\n`;
		const waterGoal = (summary.goals as Record<string, number>)['water'] ?? 0;
		out += `- **Wasser**: ${r0(summary.water_intake)} / ${r0(waterGoal)} ml${pct(summary.water_intake, waterGoal)}\n`;
		if (summary.steps) out += `- **Schritte**: ${summary.steps}\n`;
		if (summary.activity_energy) out += `- **Aktivitätskalorien**: ${r0(summary.activity_energy)} kcal\n`;
		if (summary.user?.current_weight) out += `- **Gewicht (aktuell)**: ${summary.user.current_weight} kg\n`;
		out += '\n';

		out += `## Mahlzeiten\n`;
		out += '| Mahlzeit | kcal | Protein | KH | Fett |\n|---|---|---|---|---|\n';
		for (const dt of DAYTIMES) {
			const m = perMeal[dt];
			out += `| ${DAYTIME_LABEL[dt]} | ${r0(m.kcal)} | ${r0(m.protein)} g | ${r0(m.carbs)} g | ${r0(m.fat)} g |\n`;
		}

		if (includeItems) {
			try {
				const consumed = await this.client.user.getConsumedItems({ date });
				const items = consumed.products.slice(0, 40);
				if (items.length > 0) {
					const products = await mapLimit(items, 4, item =>
						this.client.products.get(item.product_id).catch(() => null)
					);
					out += `\n## Einträge\n`;
					for (const dt of DAYTIMES) {
						const rows = items
							.map((item, i) => ({ item, product: products[i] }))
							.filter(({ item }) => item.daytime === dt);
						if (rows.length === 0) continue;
						out += `**${DAYTIME_LABEL[dt]}**\n`;
						for (const { item, product } of rows) {
							const name = product?.name ?? item.product_id;
							const qty = item.serving
								? `${item.serving_quantity ?? ''} ${item.serving}`.trim()
								: `${item.amount ?? ''} ${product?.base_unit ?? 'g'}`.trim();
							out += `- ${name} – ${qty}\n`;
						}
					}
				}
			} catch {
				// Items are optional; summary already delivered.
			}
		}

		return out;
	}

	/** Short block for embedding into another tool's output (e.g. get_today). */
	async getTodayBrief(): Promise<string> {
		const summary = await this.client.user.getDailySummary({ date: new Date() });
		const goals = macrosFrom(summary.goals as Record<string, number>);
		const total: MacroSet = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
		for (const dt of DAYTIMES) {
			const m = macrosFrom(summary.meals[dt].nutrients as Record<string, number>);
			total.kcal += m.kcal;
			total.protein += m.protein;
			total.carbs += m.carbs;
			total.fat += m.fat;
		}
		let out = `## Ernährung heute (Yazio)\n`;
		out += `- **Kalorien**: ${r0(total.kcal)} / ${r0(goals.kcal)} kcal${pct(total.kcal, goals.kcal)}\n`;
		out += `- **Protein**: ${r0(total.protein)} / ${r0(goals.protein)} g${pct(total.protein, goals.protein)}\n`;
		out += `- **KH / Fett**: ${r0(total.carbs)} g / ${r0(total.fat)} g\n`;
		out += `- **Wasser**: ${r0(summary.water_intake)} ml\n`;
		return out;
	}

	/** Daily totals over a range, plus averages and goal adherence. */
	async getTrends(days: number): Promise<string> {
		const dates = daysBack(Math.min(Math.max(days, 1), 30));
		const rows = await mapLimit(dates, 3, async date => {
			try {
				const s = await this.client.user.getDailySummary({ date });
				const goals = macrosFrom(s.goals as Record<string, number>);
				const t: MacroSet = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
				for (const dt of DAYTIMES) {
					const m = macrosFrom(s.meals[dt].nutrients as Record<string, number>);
					t.kcal += m.kcal;
					t.protein += m.protein;
					t.carbs += m.carbs;
					t.fat += m.fat;
				}
				return { date, t, goals, water: s.water_intake, steps: s.steps };
			} catch {
				return null;
			}
		});

		const valid = rows.filter((r): r is NonNullable<typeof r> => r !== null && r.t.kcal > 0);
		if (valid.length === 0) return 'Keine Yazio-Daten im Zeitraum.';

		let out = `# Ernährungstrend (letzte ${dates.length} Tage, ${valid.length} mit Einträgen)\n\n`;
		out += '| Datum | kcal | Protein | KH | Fett | Wasser | Schritte |\n|---|---|---|---|---|---|---|\n';
		for (const r of valid) {
			out += `| ${ymd(r.date)} | ${r0(r.t.kcal)} | ${r0(r.t.protein)} g | ${r0(r.t.carbs)} g | ${r0(r.t.fat)} g | ${r0(r.water)} ml | ${r.steps} |\n`;
		}

		const avg = (sel: (r: (typeof valid)[number]) => number) =>
			valid.reduce((s, r) => s + sel(r), 0) / valid.length;
		const g = valid[valid.length - 1].goals;
		out += `\n## Durchschnitt (nur Tage mit Einträgen)\n`;
		out += `- **Kalorien**: ${r0(avg(r => r.t.kcal))} kcal (Ziel ${r0(g.kcal)})\n`;
		out += `- **Protein**: ${r0(avg(r => r.t.protein))} g (Ziel ${r0(g.protein)})\n`;
		out += `- **Kohlenhydrate**: ${r0(avg(r => r.t.carbs))} g (Ziel ${r0(g.carbs)})\n`;
		out += `- **Fett**: ${r0(avg(r => r.t.fat))} g (Ziel ${r0(g.fat)})\n`;
		out += `- **Wasser**: ${r0(avg(r => r.water))} ml\n`;
		const proteinHit = valid.filter(r => r.t.protein >= g.protein * 0.9).length;
		out += `- **Proteinziel erreicht (≥ 90 %)**: ${proteinHit} von ${valid.length} Tagen\n`;
		return out;
	}

	async searchFood(query: string): Promise<string> {
		const results = await this.client.products.search({ query });
		if (results.length === 0) return `Keine Treffer für „${query}".`;
		let out = `# Suche: ${query}\n\n`;
		out += '| Produkt | Hersteller | pro Portion | kcal | Protein | KH | Fett | product_id |\n|---|---|---|---|---|---|---|---|\n';
		for (const p of results.slice(0, 15)) {
			const n = p.nutrients;
			out += `| ${p.name}${p.is_verified ? ' ✓' : ''} | ${p.producer || '–'} | ${p.serving_quantity} ${p.serving} (${p.amount} ${p.base_unit}) | ${r0(n['energy.energy'])} | ${r0(n['nutrient.protein'])} g | ${r0(n['nutrient.carb'])} g | ${r0(n['nutrient.fat'])} g | ${p.product_id} |\n`;
		}
		out += `\nZum Loggen: log_food mit product_id, daytime und entweder amount (in ${results[0].base_unit}) oder serving + serving_quantity.`;
		return out;
	}

	async logFood(opts: {
		product_id: string;
		daytime: Daytime;
		amount?: number;
		serving?: string;
		serving_quantity?: number;
		date?: string;
	}): Promise<string> {
		const date = toDate(opts.date);
		const id = crypto.randomUUID();
		const product = await this.client.products.get(opts.product_id).catch(() => null);
		const name = product?.name ?? opts.product_id;

		if (opts.serving && opts.serving_quantity !== undefined) {
			await this.client.user.addConsumedItem({
				id,
				product_id: opts.product_id,
				date,
				daytime: opts.daytime,
				amount: null,
				serving: opts.serving,
				serving_quantity: opts.serving_quantity,
			});
			return `Geloggt: ${name} – ${opts.serving_quantity} ${opts.serving} (${DAYTIME_LABEL[opts.daytime]}, ${ymd(date)}). Eintrags-ID: ${id}`;
		}

		if (opts.amount === undefined) {
			return 'Fehlt: entweder amount (Grundeinheit, meist g/ml) oder serving + serving_quantity.';
		}
		await this.client.user.addConsumedItem({
			id,
			product_id: opts.product_id,
			date,
			daytime: opts.daytime,
			amount: opts.amount,
			serving: null,
			serving_quantity: null,
		});
		return `Geloggt: ${name} – ${opts.amount} ${product?.base_unit ?? 'g'} (${DAYTIME_LABEL[opts.daytime]}, ${ymd(date)}). Eintrags-ID: ${id}`;
	}

	async removeFood(entryId: string): Promise<string> {
		await this.client.user.removeConsumedItem(entryId);
		return `Eintrag ${entryId} entfernt.`;
	}

	async getWeightHistory(days: number): Promise<string> {
		const dates = daysBack(Math.min(Math.max(days, 1), 90));
		const rows = await mapLimit(dates, 4, async date => {
			try {
				const w = await this.client.user.getWeight({ date });
				return w?.value ? { date, value: w.value } : null;
			} catch {
				return null;
			}
		});
		const valid = rows.filter((r): r is NonNullable<typeof r> => r !== null);
		// getWeight returns the last known value, so collapse repeated readings.
		const changes = valid.filter((r, i) => i === 0 || r.value !== valid[i - 1].value);
		if (changes.length === 0) return 'Keine Gewichtseinträge im Zeitraum.';

		let out = `# Gewichtsverlauf (letzte ${dates.length} Tage)\n\n| Datum | kg |\n|---|---|\n`;
		for (const r of changes) out += `| ${ymd(r.date)} | ${r.value.toFixed(1)} |\n`;
		const first = changes[0].value;
		const last = changes[changes.length - 1].value;
		out += `\n**Veränderung**: ${(last - first >= 0 ? '+' : '')}${(last - first).toFixed(1)} kg (${first.toFixed(1)} → ${last.toFixed(1)} kg)\n`;
		return out;
	}

	async getGoals(): Promise<string> {
		const [goals, profile] = await Promise.all([
			this.client.user.getGoals({ date: new Date() }),
			this.client.user.get().catch(() => null),
		]);
		let out = `# Yazio-Ziele\n\n`;
		out += `- **Kalorien**: ${r0(goals['energy.energy'])} kcal/Tag\n`;
		out += `- **Protein**: ${r0(goals['nutrient.protein'])} g\n`;
		out += `- **Kohlenhydrate**: ${r0(goals['nutrient.carb'])} g\n`;
		out += `- **Fett**: ${r0(goals['nutrient.fat'])} g\n`;
		out += `- **Wasser**: ${r0(goals['water'])} ml\n`;
		out += `- **Schritte**: ${goals['activity.step']}\n`;
		out += `- **Zielgewicht**: ${goals['bodyvalue.weight']} kg\n`;
		if (profile) {
			out += `\n## Profil\n`;
			out += `- **Ziel**: ${profile.goal}\n`;
			if (profile.diet) out += `- **Diät**: ${profile.diet.name} (KH ${profile.diet.carb_percentage} % / Protein ${profile.diet.protein_percentage} % / Fett ${profile.diet.fat_percentage} %)\n`;
			out += `- **Größe**: ${profile.body_height} cm, **Startgewicht**: ${profile.start_weight} kg\n`;
			out += `- **Aktivitätsgrad**: ${profile.activity_degree}, **Ziel/Woche**: ${profile.weight_change_per_week} kg\n`;
		}
		return out;
	}
}
