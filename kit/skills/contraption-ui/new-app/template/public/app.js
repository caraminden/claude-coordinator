// {{title}}'s page script. Citadel's parts come from /apps/_citadel/, live (citadel:contraption-ui).
const who = document.getElementById('who');
try {
  const res = await fetch('api/me');
  if (!res.ok) throw new Error(`${res.status}`);
  const me = await res.json();
  who.textContent = `Signed in as ${me.name} (${me.login}).`;
} catch (err) {
  who.textContent = `Couldn't tell who you are (${err.message}). Open this app from Citadel.`;
}
