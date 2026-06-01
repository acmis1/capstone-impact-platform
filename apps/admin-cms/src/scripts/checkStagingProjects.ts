import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { SupabaseProjectRepository } from '../repositories/SupabaseProjectRepository';

async function check() {
  const repository = new SupabaseProjectRepository();

  console.log('Querying staging database projects...');
  let projects;
  try {
    projects = await repository.listProjects();
  } catch (e: any) {
    console.error('❌ Failed to connect or query staging database:', e.message);
    process.exit(1);
  }

  const total = projects.length;
  const statusCounts: Record<string, number> = {};
  let publicEligible = 0;

  projects.forEach((p) => {
    statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
    if (p.status === 'approved' || p.status === 'published') {
      publicEligible++;
    }
  });

  console.log('\n====================================================');
  console.log('📊 STAGING DATABASE PROJECT METRICS');
  console.log('====================================================');
  console.log(`Total Staging Projects:       ${total}`);
  console.log(`Public-Eligible Projects:     ${publicEligible}`);
  console.log('----------------------------------------------------');
  console.log('Breakdown by Status:');
  
  const allStatuses = ['draft', 'submitted', 'in_review', 'changes_requested', 'approved', 'published', 'archived', 'deleted'];
  allStatuses.forEach((status) => {
    const count = statusCounts[status] || 0;
    console.log(` - [${status.toUpperCase().padEnd(17)}]: ${count}`);
  });
  console.log('====================================================\n');
}

check();
