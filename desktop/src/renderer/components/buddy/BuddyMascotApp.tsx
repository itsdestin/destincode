import { useEffect } from 'react';
import { BuddyMascot } from './BuddyMascot';

export function BuddyMascotApp() {
  useEffect(() => {
    document.body.setAttribute('data-mode', 'buddy-mascot');
  }, []);

  return <BuddyMascot />;
}
