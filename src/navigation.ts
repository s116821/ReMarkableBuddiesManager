/** Presentation only. These destinations never grant host or tablet authority. */
export const destinations = [
  {id: 'tablet', label: 'Tablet', description: 'Your connection, tablet state and updates.', items: []},
  {id: 'settings', label: 'Settings', description: 'Make Reader and Writer work your way.', items: [
    {id: 'reader', label: 'Reader & Writer'}, {id: 'model', label: 'Model connection'},
    {id: 'research', label: 'Research'}, {id: 'personalization', label: 'Personalization'},
    {id: 'memory', label: 'Memory'}, {id: 'preferences', label: 'Transfer preferences'},
  ]},
  {id: 'data', label: 'Data', description: 'Find and manage the data Buddy keeps on your tablet.', items: [
    {id: 'conversations', label: 'Conversations'}, {id: 'memory', label: 'Memory'},
    {id: 'handwriting', label: 'Handwriting'}, {id: 'storage', label: 'Storage'},
  ]},
  {id: 'backup', label: 'Backup & sync', description: 'Your Google account, saved data mode and portable archives.', items: [
    {id: 'account', label: 'Google account'}, {id: 'mode', label: 'Data mode'}, {id: 'archives', label: 'Export & restore'},
  ]},
  {id: 'troubleshooting', label: 'Troubleshooting', description: 'Inspect saved settings and technical details when you need them.', items: [
    {id: 'configuration', label: 'Configuration report'}, {id: 'diagnostics', label: 'Diagnostic settings'}, {id: 'runtime', label: 'Buddy version'},
  ]},
] as const;
export type Destination = typeof destinations[number]['id'];
export interface Location { destination: Destination; item: string }
export function resolveLocation(destination: string, item?: string): Location {
  const entry = destinations.find(row => row.id === destination) ?? destinations[0];
  return {destination: entry.id, item: entry.items.find(row => row.id === item)?.id ?? entry.items[0]?.id ?? ''};
}
export function initialLocation(): Location {
  try {
    const value = JSON.parse(sessionStorage.getItem('manager.navigation') ?? 'null');
    return resolveLocation(value?.destination, value?.item);
  } catch { return resolveLocation('tablet'); }
}
