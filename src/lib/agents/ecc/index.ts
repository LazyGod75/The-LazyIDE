/* index.ts — Reassembles ECC_AGENTS from the per-agent persona modules in this directory
   (each sibling file = one agent, split out of the former eccAgents.ts monolith).
   Re-exports the exact same public API eccAgents.ts used to provide directly:
   EccAgent (type), ECC_AGENTS (const), eccToLazyAgent (function). The original 67
   agents keep their original relative order; the 6 content/creative agents added
   to close the marketing/content gap (see managerEccCatalog.ts) are inserted
   alphabetically alongside them, same convention as every other entry. Total: 73. */

import type { EccAgent } from './eccAgentTypes.js';
import { a11yArchitect } from './a11y-architect.js';
import { agentEvaluator } from './agent-evaluator.js';
import { architect } from './architect.js';
import { brandIdentity } from './brand-identity.js';
import { buildErrorResolver } from './build-error-resolver.js';
import { carouselDesigner } from './carousel-designer.js';
import { chiefOfStaff } from './chief-of-staff.js';
import { codeArchitect } from './code-architect.js';
import { codeExplorer } from './code-explorer.js';
import { codeReviewer } from './code-reviewer.js';
import { codeSimplifier } from './code-simplifier.js';
import { commentAnalyzer } from './comment-analyzer.js';
import { contentStrategist } from './content-strategist.js';
import { conversationAnalyzer } from './conversation-analyzer.js';
import { copywriter } from './copywriter.js';
import { cppBuildResolver } from './cpp-build-resolver.js';
import { cppReviewer } from './cpp-reviewer.js';
import { csharpReviewer } from './csharp-reviewer.js';
import { dartBuildResolver } from './dart-build-resolver.js';
import { databaseReviewer } from './database-reviewer.js';
import { djangoBuildResolver } from './django-build-resolver.js';
import { djangoReviewer } from './django-reviewer.js';
import { docUpdater } from './doc-updater.js';
import { docsLookup } from './docs-lookup.js';
import { e2eRunner } from './e2e-runner.js';
import { fastapiReviewer } from './fastapi-reviewer.js';
import { flutterReviewer } from './flutter-reviewer.js';
import { fsharpReviewer } from './fsharp-reviewer.js';
import { ganEvaluator } from './gan-evaluator.js';
import { ganGenerator } from './gan-generator.js';
import { ganPlanner } from './gan-planner.js';
import { goBuildResolver } from './go-build-resolver.js';
import { goReviewer } from './go-reviewer.js';
import { harmonyosAppResolver } from './harmonyos-app-resolver.js';
import { harnessOptimizer } from './harness-optimizer.js';
import { healthcareReviewer } from './healthcare-reviewer.js';
import { homelabArchitect } from './homelab-architect.js';
import { javaBuildResolver } from './java-build-resolver.js';
import { javaReviewer } from './java-reviewer.js';
import { kotlinBuildResolver } from './kotlin-build-resolver.js';
import { kotlinReviewer } from './kotlin-reviewer.js';
import { loopOperator } from './loop-operator.js';
import { marketingAgent } from './marketing-agent.js';
import { mleReviewer } from './mle-reviewer.js';
import { networkArchitect } from './network-architect.js';
import { networkConfigReviewer } from './network-config-reviewer.js';
import { networkTroubleshooter } from './network-troubleshooter.js';
import { opensourceForker } from './opensource-forker.js';
import { opensourcePackager } from './opensource-packager.js';
import { opensourceSanitizer } from './opensource-sanitizer.js';
import { performanceOptimizer } from './performance-optimizer.js';
import { phpReviewer } from './php-reviewer.js';
import { planner } from './planner.js';
import { prTestAnalyzer } from './pr-test-analyzer.js';
import { pythonReviewer } from './python-reviewer.js';
import { pytorchBuildResolver } from './pytorch-build-resolver.js';
import { reactBuildResolver } from './react-build-resolver.js';
import { reactReviewer } from './react-reviewer.js';
import { refactorCleaner } from './refactor-cleaner.js';
import { rustBuildResolver } from './rust-build-resolver.js';
import { rustReviewer } from './rust-reviewer.js';
import { securityReviewer } from './security-reviewer.js';
import { seoSpecialist } from './seo-specialist.js';
import { silentFailureHunter } from './silent-failure-hunter.js';
import { specMiner } from './spec-miner.js';
import { swiftBuildResolver } from './swift-build-resolver.js';
import { swiftReviewer } from './swift-reviewer.js';
import { tddGuide } from './tdd-guide.js';
import { typeDesignAnalyzer } from './type-design-analyzer.js';
import { typescriptReviewer } from './typescript-reviewer.js';
import { videoProducer } from './video-producer.js';
import { vueReviewer } from './vue-reviewer.js';
import { webResearcher } from './web-researcher.js';

export type { EccAgent } from './eccAgentTypes.js';
export { eccToLazyAgent } from './eccToLazyAgent.js';

export const ECC_AGENTS: EccAgent[] = [
  a11yArchitect,
  agentEvaluator,
  architect,
  brandIdentity,
  buildErrorResolver,
  carouselDesigner,
  chiefOfStaff,
  codeArchitect,
  codeExplorer,
  codeReviewer,
  codeSimplifier,
  commentAnalyzer,
  contentStrategist,
  conversationAnalyzer,
  copywriter,
  cppBuildResolver,
  cppReviewer,
  csharpReviewer,
  dartBuildResolver,
  databaseReviewer,
  djangoBuildResolver,
  djangoReviewer,
  docUpdater,
  docsLookup,
  e2eRunner,
  fastapiReviewer,
  flutterReviewer,
  fsharpReviewer,
  ganEvaluator,
  ganGenerator,
  ganPlanner,
  goBuildResolver,
  goReviewer,
  harmonyosAppResolver,
  harnessOptimizer,
  healthcareReviewer,
  homelabArchitect,
  javaBuildResolver,
  javaReviewer,
  kotlinBuildResolver,
  kotlinReviewer,
  loopOperator,
  marketingAgent,
  mleReviewer,
  networkArchitect,
  networkConfigReviewer,
  networkTroubleshooter,
  opensourceForker,
  opensourcePackager,
  opensourceSanitizer,
  performanceOptimizer,
  phpReviewer,
  planner,
  prTestAnalyzer,
  pythonReviewer,
  pytorchBuildResolver,
  reactBuildResolver,
  reactReviewer,
  refactorCleaner,
  rustBuildResolver,
  rustReviewer,
  securityReviewer,
  seoSpecialist,
  silentFailureHunter,
  specMiner,
  swiftBuildResolver,
  swiftReviewer,
  tddGuide,
  typeDesignAnalyzer,
  typescriptReviewer,
  videoProducer,
  vueReviewer,
  webResearcher,
];
