import type { UserInfo, ConfigData, ChartData, AppClient } from "./user";

/** A single downloadable config file (inline base64 data: URL, no round-trip). */
export interface DownloadEntry {
  name: string;
  filename: string;
  data_url: string;
}

/** IKEv2/IPsec host: inline credentials + optional .mobileconfig download. */
export interface IKEv2Detail {
  remark: string;
  server: string;
  username: string;
  password: string;
  identity?: string;
  download?: DownloadEntry | null;
}

export interface InitialData {
  user?: UserInfo; // User data as structured object from template
  links?: string[];
  apps?: AppClient[];
  // Fork additions: file-based backends (one card per file).
  openvpn_configs?: DownloadEntry[];
  wireguard_configs?: DownloadEntry[];
  ikev2_details?: IKEv2Detail[];
}

declare global {
  interface Window {
    __INITIAL_DATA__?: InitialData;
  }
}

export {};
