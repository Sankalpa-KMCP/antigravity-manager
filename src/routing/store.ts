import fs from 'fs';
import path from 'path';
import { ProjectMapping, ProjectStatus, TargetState } from '../types';

export class ProjectStore {
  private filePath: string;
  private projects: Record<string, ProjectMapping> = {};

  constructor(dataDir?: string) {
    const dir = dataDir || path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {}
    }
    this.filePath = path.join(dir, 'projects.json');
    this.load();
  }

  private load(): void {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.projects = JSON.parse(raw);
        return;
      } catch (err) {
        console.warn(`Failed to parse projects.json, initializing defaults: ${(err as Error).message}`);
      }
    }

    // Default non-sensitive project mappings
    this.projects = {
      'DentCare': {
        name: 'DentCare',
        target: 'ide',
        preferredAccountEmail: 'account-a@example.invalid'
      },
      'Research': {
        name: 'Research',
        target: 'antigravity2',
        preferredAccountEmail: 'account-b@example.invalid'
      }
    };
    this.save();
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.projects, null, 2), 'utf8');
    } catch (err) {
      console.error(`Failed to save projects.json: ${(err as Error).message}`);
    }
  }

  getProjects(): ProjectMapping[] {
    return Object.values(this.projects);
  }

  addOrUpdateProject(mapping: ProjectMapping): void {
    if (!mapping.name || !mapping.target || !mapping.preferredAccountEmail) {
      throw new Error('Project mapping requires name, target, and preferredAccountEmail');
    }
    this.projects[mapping.name] = {
      name: mapping.name,
      path: mapping.path || '',
      target: mapping.target,
      preferredAccountEmail: mapping.preferredAccountEmail.trim().toLowerCase()
    };
    this.save();
  }

  removeProject(name: string): boolean {
    if (this.projects[name]) {
      delete this.projects[name];
      this.save();
      return true;
    }
    return false;
  }

  evaluateStatuses(targets: TargetState[]): ProjectStatus[] {
    const result: ProjectStatus[] = [];

    for (const p of Object.values(this.projects)) {
      const targetState = targets.find(t => t.id === p.target);
      const isTargetRunning = Boolean(targetState?.isRunning);
      const isTargetBusy = targetState?.trajectoryStatus?.state === 'BUSY';
      const currentEmail = targetState?.email?.trim().toLowerCase() || null;
      const preferred = p.preferredAccountEmail.trim().toLowerCase();

      let status: 'READY' | 'SWITCH_REQUIRED' | 'TARGET_OFFLINE' = 'TARGET_OFFLINE';

      if (!isTargetRunning) {
        status = 'TARGET_OFFLINE';
      } else if (currentEmail && currentEmail === preferred) {
        status = 'READY';
      } else {
        status = 'SWITCH_REQUIRED';
      }

      result.push({
        name: p.name,
        path: p.path,
        target: p.target,
        targetName: targetState?.name || (p.target === 'ide' ? 'Antigravity IDE' : 'Antigravity 2.0'),
        preferredAccountEmail: p.preferredAccountEmail,
        currentAccountEmail: targetState?.email || null,
        isTargetRunning,
        isTargetBusy,
        status
      });
    }

    return result;
  }
}
