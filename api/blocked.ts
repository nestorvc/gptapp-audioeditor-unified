export default function handler(req: any, res: any) {
  res.status(403).json({ error: 'Forbidden' });
}

