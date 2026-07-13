// Starter templates handed to a brand-new workspace.
export const blankProfile = () => ({
  name: '<Your name>',
  headline: '<e.g. Senior Backend Engineer>',
  contact: { email: '<email>', phone: '<phone>', linkedin: '<linkedin url>', location: '<City, State>' },
  summary: '<2-3 sentence professional summary — real and specific>',
  experienceYears: '<e.g. 8+>',
  workAuthorization: '<e.g. US Citizen — no sponsorship required>',
  location: { base: '<your metro>', openTo: ['remote', 'hybrid', 'onsite'], willingToRelocate: '<Yes/No>' },
  roles: [
    { title: '<title>', organization: '<company>', start: '<MM/YYYY>', end: 'present',
      facts: ['<verified accomplishment with an EXACT number>', '<add 3-6 per role — real metrics only>'] },
  ],
  skills: ['<skill>', '<skill>'],
  certifications: [{ name: '<only certs you actually hold>', year: '' }],
  targetRoles: { core: ['<your strongest-fit role families>'], stretch: ['<aspirational>'] },
});

export const defaultSettings = () => ({
  _readme: 'profiles: which job titles to keep. watchlist: public ATS boards to poll (ats greenhouse|lever|ashby, board = slug in the careers URL). Edit both for your field.',
  profiles: [
    { name: 'engineering', titleKeywords: ['Software Engineer', 'Backend Engineer', 'Platform Engineer'] },
    { name: 'data', titleKeywords: ['Data Engineer', 'Data Scientist', 'ML Engineer'] },
  ],
  watchlist: [{ ats: 'greenhouse', board: 'anthropic' }],
});
