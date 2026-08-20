/**
 * The configurable fact schema (DESIGN.md §7). Add a new fact by adding a row
 * here — the extraction prompt (src/pipeline/extract.ts) and the MCP tool
 * output are both built dynamically from this list, so no other code needs
 * to change.
 */

export type FactDataType = "number" | "string" | "date" | "money" | "plan_list";

export interface FactDefinition {
  fact_key: string;
  display_name: string;
  description: string;
  data_type: FactDataType;
  extraction_hint: string;
}

export const FACT_DEFINITIONS: FactDefinition[] = [
  {
    fact_key: "employee_count",
    display_name: "Benefits-Eligible Employee Count",
    description:
      "The current number of benefits-eligible employees at the client.",
    data_type: "number",
    extraction_hint:
      "Use the most recent corrected figure if the transcript revises an earlier count. Exclude contractors and seasonal workers unless the transcript explicitly says to include them.",
  },
  {
    fact_key: "benefit_cycle_start",
    display_name: "Benefit Cycle Start Date",
    description: "The date the client's next benefit plan cycle begins.",
    data_type: "date",
    extraction_hint: "Return an ISO-8601 date, e.g. 2026-07-01.",
  },
  {
    fact_key: "preferred_plan_type",
    display_name: "Preferred Plan Type",
    description: "The client's preferred health plan type.",
    data_type: "string",
    extraction_hint:
      'Use a short standard label such as "HMO", "PPO", or "HDHP".',
  },
  {
    fact_key: "employer_budget_monthly",
    display_name: "Employer Budget (per employee per month)",
    description:
      "The employer's budget in US dollars per benefits-eligible employee per month.",
    data_type: "money",
    extraction_hint: "Return a plain number of US dollars, no currency symbol.",
  },
  {
    fact_key: "incumbent_plan_pricing",
    display_name: "Incumbent Broker Plan Pricing",
    description:
      "Plans and per-employee monthly pricing found by the incumbent broker.",
    data_type: "plan_list",
    extraction_hint:
      'Return a list of {"plan_name": string, "monthly_price_usd": number} objects, one per plan mentioned in this transcript. Only report what this specific transcript states, even if a later meeting revises it.',
  },
];

export const FACT_KEYS = FACT_DEFINITIONS.map((f) => f.fact_key);
