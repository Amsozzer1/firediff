export class FirebaseJsonError extends Error {
  override name = 'FirebaseJsonError';
}

/** The Firestore rules path from ./firebase.json: firestore.rules, or the firestore array's only rules file. */
export function rulesPathFromFirebaseJson(text: string): string {
  const json = JSON.parse(text) as { firestore?: { rules?: string } | Array<{ rules?: string; database?: string }> };
  const fs = json.firestore;
  if (!fs) throw new FirebaseJsonError('firebase.json has no "firestore" section');
  if (Array.isArray(fs)) {
    const files = [...new Set(fs.map((e) => e.rules).filter((r): r is string => !!r))];
    if (files.length === 0) throw new FirebaseJsonError('firebase.json "firestore" entries have no "rules" file');
    if (files.length > 1) {
      throw new FirebaseJsonError(`firebase.json lists several Firestore rules files (${files.join(', ')}); pass <base.rules> <head.rules> instead`);
    }
    return files[0]!;
  }
  if (!fs.rules) throw new FirebaseJsonError('firebase.json "firestore" has no "rules" file');
  return fs.rules;
}
