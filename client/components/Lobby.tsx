import { profiles } from '../domain/presentation.js';
import { RoomCreation } from './RoomTools.js';

export function Lobby({ navigate }: { navigate: (path: string) => void }) {
  return <main className="lobby" aria-label="游戏大厅">
    <div className="lobby-cast" aria-label="三位 Q 版牌手">{profiles.map((profile) => <figure key={profile.name}>
      <img src={profile.avatar} alt={profile.name + ' Q版角色'} /><figcaption>{profile.name}</figcaption>
    </figure>)}</div>
    <div className="lobby-intro">
      <RoomCreation navigate={navigate} />
    </div>
  </main>;
}
