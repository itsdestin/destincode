import { ulid } from 'ulid';

export function newArtifactId(): string {
  return `art_${ulid()}`;
}

export function newVersionId(): string {
  return `ver_${ulid()}`;
}

export function newProjectId(): string {
  return ulid();
}
