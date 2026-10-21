// Words that suggest a skill, in English and Romanian (the two languages the
// dashboard is written and used in). Matching is by word START, so "securitate"
// also catches "securitatea"; a leading "=" means the whole word ("=ci" must
// not fire on "circuit"). Text is lower-cased and stripped of diacritics first,
// so write the keywords without them.
//
// These only ever SUGGEST: nothing is switched on without a click.

export const SKILL_TRIGGERS: Record<string, string[]> = {
  'answer-quality': [],
  'clear-writing-and-editing': ['scrie un email', 'write an email', 'email', 'eseu', 'essay', 'cover letter', 'scrisoare de intentie', 'proofread', 'corecteaza', 'editeaza', 'improve my writing', 'imbunatateste textul', 'draft', 'postare', 'blog post'],
  'data-analysis': ['datele', 'dataset', 'data analysis', 'analiza datelor', 'csv', 'excel', 'spreadsheet', 'tabel', 'statistic', 'medie', 'average', 'median', 'grafic', 'chart', 'sql', 'trend', 'formula'],
  'explain-and-teach': ['explica', 'explain', 'invata-ma', 'teach me', 'cum functioneaza', 'how does', 'eli5', 'ce inseamna', 'what is', 'ce este', 'tema', 'homework', 'inteleg'],
  'research-and-fact-checking': ['adevarat', 'is it true', 'fact check', 'verifica', 'sursa', 'source', 'studiu', 'study', 'cercetare', 'research', 'compara', 'compare', 'istoric', 'history', 'statistica'],
  'step-by-step-reasoning': ['calculeaza', 'calculate', 'problema', 'puzzle', 'ghicitoare', 'logic', 'rezolva', 'solve', 'demonstreaza', 'prove', 'cate ', 'how many', 'estimeaza', 'estimate', 'probabilit'],
  'summarize-and-distill': ['rezuma', 'rezumat', 'summar', 'tl;dr', 'tldr', 'pe scurt', 'in short', 'puncte cheie', 'key points', 'notite de', 'meeting notes', 'condenseaza'],
  'translation-and-localization': ['traduce', 'translate', 'traducere', 'translation', 'in engleza', 'in romana', 'to english', 'to romanian', 'in franceza', 'in spaniola', 'localiz'],
  'api-and-interface-design': ['api', 'endpoint', 'rest', 'graphql', 'interfata', 'contract', 'schema', 'versionare', 'backward'],
  'browser-testing-with-devtools': ['devtools', 'e2e', 'playwright', 'cypress', 'in browser', 'consola browser', 'network tab'],
  'ci-cd-and-automation': ['=ci', 'cicd', 'pipeline', 'github actions', 'workflow', 'deploy', 'docker', 'automatiz', 'build fail'],
  'code-review-and-quality': ['review', 'revizuire', 'pull request', '=pr', 'calitatea codului', 'code quality', 'merge'],
  'code-simplification': ['simplific', 'refactor', 'prea complicat', 'too complex', 'curata codul', 'clean up', 'readab'],
  'constraint-driven-development': ['constrang', 'constraint', 'standarde', 'reguli de', 'guardrail', 'quality bar', 'limite de'],
  'context-engineering': ['context window', 'fereastra de context', 'prompt', 'agent', 'llm', 'rules file', 'instructiuni pentru ai'],
  'debugging-and-error-recovery': ['bug', 'eroare', 'error', 'crash', 'exception', 'nu merge', 'nu functioneaza', 'not working', 'stack trace', 'failing', 'cade', 'broken', 'debug'],
  'deprecation-and-migration': ['migrare', 'migration', 'deprec', 'upgrade', 'actualizare de versiune', 'inlocui', 'sunset', 'legacy'],
  'documentation-and-adrs': ['documentat', 'readme', 'adr', 'changelog', 'docs', 'documentation', 'decizie de arhitectura'],
  'doubt-driven-development': ['sunt sigur', 'am dreptate', 'stress-test', 'verifica-mi', 'critic', 'devil', 'ce poate merge prost', 'second opinion', 'pareri'],
  'frontend-ui-engineering': ['frontend', 'interfata de utilizator', '=ui', '=ux', 'react', 'css', 'componenta', 'component', 'responsive', 'accesibilit', 'design system'],
  'git-workflow-and-versioning': ['=git', 'commit', 'branch', 'rebase', 'versionare', 'semver', 'tag de versiune', 'merge conflict'],
  'humanizer': ['humaniz', 'sounds like ai', 'suna a ai', 'suna ca ai', 'ai-generated', 'generat de ai', 'scris de ai', 'text ai', 'chatgpt text', 'mai natural', 'more natural', 'robotic', 'rescrie', 'rewrite', 'ton uman', 'human-sounding', 'ai tells'],
  'idea-refine': ['idee', 'idea', 'brainstorm', 'concept', 'am o idee', 'ce zici de', 'variante'],
  'incremental-implementation': ['incremental', 'pas cu pas', 'step by step', 'implementeaza', 'implement', 'feature nou', 'o functionalitate'],
  'interview-me': ['vreau sa construiesc', 'vreau sa fac', 'build me', 'i want to build', 'nu stiu de unde', 'ajuta-ma sa decid', 'intreaba-ma', 'interview me', 'grill me', 'nu sunt sigur ce'],
  'observability-and-instrumentation': ['observabil', 'logging', 'loguri', 'logs', 'metrici', 'metrics', 'monitoriz', 'monitoring', 'tracing', 'alerte', 'telemetr'],
  'performance-optimization': ['performant', 'performance', 'lent', 'slow', 'latenta', 'latency', 'optimiz', 'memorie', 'memory leak', 'bundle size', 'core web vitals', 'lcp'],
  'planning-and-task-breakdown': ['plan', 'taskuri', 'tasks', 'roadmap', 'pasii', 'impartire', 'breakdown', 'estimare', 'milestone'],
  'security-and-hardening': ['securitate', 'security', 'vulnerab', 'xss', 'csrf', 'injection', 'sql injection', 'autentific', 'authentication', 'parola', 'password', 'secrete', 'secrets', 'owasp', 'token', 'ssrf', 'criptare', 'encrypt'],
  'shipping-and-launch': ['lansare', 'launch', 'release', 'productie', 'production', 'go live', 'rollout', 'rollback', 'feature flag'],
  'source-driven-development': ['documentatia oficiala', 'official docs', 'ultima versiune', 'latest version', 'conform documentatiei', 'cum se face in', 'best practice'],
  'spec-driven-development': ['specificat', 'spec', 'cerinte', 'requirements', '=prd', 'user stories', 'acceptance criteria', 'criterii de acceptare'],
  'test-driven-development': ['teste', 'testare', 'unit test', '=tdd', 'test coverage', 'acoperire', 'testeaza', 'write tests', 'regression'],
  'using-agent-skills': [],
};
