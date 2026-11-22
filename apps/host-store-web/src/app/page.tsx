import { redirect } from 'next/navigation';

import { currentStaff } from '../lib/host';

export default async function Home() {
  redirect((await currentStaff()) ? '/orders' : '/login');
}
