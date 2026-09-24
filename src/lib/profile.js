import { doc, getDoc, getDocFromServer, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore'

export const profileName = (user) =>
  (user.displayName || user.email?.split('@')[0] || 'Bidder').trim().slice(0, 80)

// Creates users/{uid} on first login, otherwise touches lastSeen.
// The server-set lastSeen doubles as a clock sample: comparing it with the local
// time around the write gives the client's offset from server time, so countdowns
// match what the rules enforce. Cost per login: 1 write + 1 read.
export async function syncProfile(db, user) {
  const ref = doc(db, 'users', user.uid)
  let t0 = Date.now()
  try {
    await updateDoc(ref, { lastSeen: serverTimestamp() })
  } catch (e) {
    // Missing doc surfaces as not-found or, since the update rule reads the
    // existing doc, permission-denied. Either way try to create it.
    if (e.code !== 'not-found' && e.code !== 'permission-denied') throw e
    t0 = Date.now()
    await setDoc(ref, {
      name: profileName(user),
      email: user.email,
      createdAt: serverTimestamp(),
      lastSeen: serverTimestamp(),
    })
  }
  const t1 = Date.now()
  const profile = (await getDocFromServer(ref)).data()
  return { profile, clockOffsetMs: profile.lastSeen.toMillis() - (t0 + t1) / 2 }
}

export async function checkAdmin(db, uid) {
  try {
    return (await getDoc(doc(db, 'admins', uid))).exists()
  } catch {
    return false
  }
}
