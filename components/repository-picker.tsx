'use client';

import { Check, ChevronDown, ChevronUp, FolderGit2 } from 'lucide-react';
import type { RepositorySummary } from '@/lib/avc/repository-visibility';
import { Select } from 'radix-ui';
import styles from './repository-picker.module.css';

type RepositoryPickerProps = {
    projects: (Pick<RepositorySummary, 'id' | 'name'> & Partial<RepositorySummary>)[];
    value: string;
    onValueChange: (value: string) => void;
};

export function RepositoryPicker({ projects, value, onValueChange }: RepositoryPickerProps) {
    const selected = projects.find(project => project.id === value);

    return (
        <Select.Root value={selected ? value : ''} onValueChange={onValueChange} disabled={!projects.length}>
            <Select.Trigger className={styles.trigger} aria-label="Repository" title={selected?.name}>
                <span className={styles.icon}><FolderGit2 size={18} aria-hidden="true" /></span>
                <span className={styles.copy}>
                    <span className={styles.caption} aria-hidden="true">Repository</span>
                    <span className={styles.value}>
                        <Select.Value placeholder={projects.length ? 'Select repository' : 'No repositories'} />
                    </span>
                </span>
                <Select.Icon className={styles.chevron}>
                    <ChevronDown size={16} aria-hidden="true" />
                </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
                <Select.Content className={styles.content} position="popper" align="start" sideOffset={8} collisionPadding={12}>
                    <Select.ScrollUpButton className={styles.scrollButton}>
                        <ChevronUp size={16} aria-hidden="true" />
                    </Select.ScrollUpButton>
                    <Select.Viewport className={styles.viewport}>
                        <Select.Group>
                            <Select.Label className={styles.heading}>
                                Switch repository<span className={styles.count}>{projects.length}</span>
                            </Select.Label>
                            {projects.map(project => (
                                <Select.Item className={styles.item} key={project.id} value={project.id} textValue={project.name} title={project.name}>
                                    <span className={styles.itemIcon}><FolderGit2 size={16} aria-hidden="true" /></span>
                                    <Select.ItemText>{project.owner?.username ? `${project.owner.username} / ` : ''}{project.name}{project.visibility ? ` · ${project.visibility}` : ''}</Select.ItemText>
                                    <Select.ItemIndicator className={styles.check}>
                                        <Check size={16} aria-hidden="true" />
                                    </Select.ItemIndicator>
                                </Select.Item>
                            ))}
                        </Select.Group>
                    </Select.Viewport>
                    <Select.ScrollDownButton className={styles.scrollButton}>
                        <ChevronDown size={16} aria-hidden="true" />
                    </Select.ScrollDownButton>
                </Select.Content>
            </Select.Portal>
        </Select.Root>
    );
}
