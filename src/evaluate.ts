import { HeuristicPredictor } from "./baseline-predictor.js";
import { heuristicEvaluationScenarios } from "./evaluation-fixtures.js";
import { evaluateScenarios } from "./evaluation.js";

const report = await evaluateScenarios(heuristicEvaluationScenarios, () => new HeuristicPredictor());
console.log(JSON.stringify(report, null, 2));
