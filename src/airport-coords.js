// airport-coords.js — lat/lng coordinates for airports the fleet uses.
//
// This is SEPARATE from airports.js (which is a timezone database) on
// purpose: the timezone DB is comprehensive (1000+ airports) but we only
// need coordinates for airports the fleet actually visits, and bundling
// coordinates for 1000+ airports would inflate the bundle for the TV
// board feature for no gain.
//
// Lookup convention: trip data uses 3- or 4-letter codes. Try the code
// as given, then with K-prefix added/removed (FAA ↔ US ICAO).
//
// If a flight references an airport not in this list, the route line
// just won't draw — better than crashing. The console will log the
// missing code so we can add it.

const COORDS = {
  // Florida
  FXE:  { lat: 26.1973, lng: -80.1707 },
  FLL:  { lat: 26.0726, lng: -80.1527 },
  MIA:  { lat: 25.7959, lng: -80.2870 },
  OPF:  { lat: 25.9070, lng: -80.2784 },
  TMB:  { lat: 25.6479, lng: -80.4327 },
  PBI:  { lat: 26.6832, lng: -80.0956 },
  TPA:  { lat: 27.9755, lng: -82.5332 },
  PIE:  { lat: 27.9106, lng: -82.6874 },
  APF:  { lat: 26.1525, lng: -81.7752 },
  RSW:  { lat: 26.5362, lng: -81.7552 },
  JAX:  { lat: 30.4941, lng: -81.6879 },
  ORL:  { lat: 28.5455, lng: -81.3329 },
  MCO:  { lat: 28.4294, lng: -81.3089 },
  ISM:  { lat: 28.2898, lng: -81.4372 },
  SFB:  { lat: 28.7776, lng: -81.2375 },
  DAB:  { lat: 29.1799, lng: -81.0581 },
  TLH:  { lat: 30.3965, lng: -84.3503 },
  PNS:  { lat: 30.4734, lng: -87.1866 },
  EYW:  { lat: 24.5561, lng: -81.7596 },
  '07FA': { lat: 25.3253, lng: -80.2747 },
  DTS:  { lat: 30.4001, lng: -86.4715 },

  // Southeast US
  ACY:  { lat: 39.4576, lng: -74.5772 },
  ATL:  { lat: 33.6407, lng: -84.4277 },
  PDK:  { lat: 33.8756, lng: -84.3022 },
  RYY:  { lat: 34.0132, lng: -84.5970 },
  CHA:  { lat: 35.0353, lng: -85.2038 },
  BNA:  { lat: 36.1245, lng: -86.6782 },
  MEM:  { lat: 35.0424, lng: -89.9767 },
  CLT:  { lat: 35.2140, lng: -80.9431 },
  ILM:  { lat: 34.2706, lng: -77.9026 },
  CHS:  { lat: 32.8986, lng: -80.0405 },
  HXD:  { lat: 32.2244, lng: -80.6975 },
  SAV:  { lat: 32.1276, lng: -81.2021 },
  AIK:  { lat: 33.6493, lng: -81.6850 },
  ARW:  { lat: 32.4122, lng: -80.6344 },
  GSP:  { lat: 34.8957, lng: -82.2189 },
  AVL:  { lat: 35.4362, lng: -82.5418 },
  LEX:  { lat: 38.0365, lng: -84.6059 },
  SDF:  { lat: 38.1744, lng: -85.7360 },
  BHM:  { lat: 33.5629, lng: -86.7535 },
  HSV:  { lat: 34.6372, lng: -86.7751 },
  TYS:  { lat: 35.8110, lng: -83.9941 },
  MSY:  { lat: 29.9934, lng: -90.2580 },
  SSI:  { lat: 31.1517, lng: -81.3914 },

  // Mid-Atlantic
  TEB:  { lat: 40.8501, lng: -74.0608 },
  MMU:  { lat: 40.7995, lng: -74.4148 },
  CDW:  { lat: 40.8752, lng: -74.2814 },
  JFK:  { lat: 40.6413, lng: -73.7781 },
  LGA:  { lat: 40.7769, lng: -73.8740 },
  EWR:  { lat: 40.6895, lng: -74.1745 },
  HPN:  { lat: 41.0670, lng: -73.7076 },
  ISP:  { lat: 40.7952, lng: -73.1002 },
  FRG:  { lat: 40.7288, lng: -73.4134 },
  IAD:  { lat: 38.9531, lng: -77.4565 },
  DCA:  { lat: 38.8521, lng: -77.0377 },
  GAI:  { lat: 39.1683, lng: -77.1660 },
  HEF:  { lat: 38.7214, lng: -77.5155 },
  BWI:  { lat: 39.1754, lng: -76.6683 },
  RIC:  { lat: 37.5052, lng: -77.3197 },
  ORF:  { lat: 36.8946, lng: -76.2012 },
  PHL:  { lat: 39.8744, lng: -75.2424 },
  PNE:  { lat: 40.0820, lng: -75.0106 },
  ABE:  { lat: 40.6521, lng: -75.4408 },
  RDU:  { lat: 35.8776, lng: -78.7875 },
  TTN:  { lat: 40.2767, lng: -74.8135 },

  // Northeast
  BOS:  { lat: 42.3656, lng: -71.0096 },
  BED:  { lat: 42.4700, lng: -71.2890 },
  ORH:  { lat: 42.2673, lng: -71.8757 },
  PVD:  { lat: 41.7240, lng: -71.4282 },
  ACK:  { lat: 41.2530, lng: -70.0602 },
  MVY:  { lat: 41.3931, lng: -70.6143 },
  HYA:  { lat: 41.6694, lng: -70.2804 },
  PWM:  { lat: 43.6462, lng: -70.3088 },
  BGR:  { lat: 44.8074, lng: -68.8281 },
  BTV:  { lat: 44.4719, lng: -73.1533 },
  ALB:  { lat: 42.7483, lng: -73.8019 },
  SYR:  { lat: 43.1112, lng: -76.1063 },
  BUF:  { lat: 42.9405, lng: -78.7322 },
  ROC:  { lat: 43.1189, lng: -77.6724 },

  // Midwest
  ORD:  { lat: 41.9742, lng: -87.9073 },
  MDW:  { lat: 41.7868, lng: -87.7522 },
  PWK:  { lat: 42.1142, lng: -87.9015 },
  DTW:  { lat: 42.2124, lng: -83.3534 },
  PTK:  { lat: 42.6655, lng: -83.4200 },
  MKE:  { lat: 42.9472, lng: -87.8966 },
  MSP:  { lat: 44.8848, lng: -93.2223 },
  STL:  { lat: 38.7487, lng: -90.3700 },
  MCI:  { lat: 39.2976, lng: -94.7139 },
  CMH:  { lat: 39.9980, lng: -82.8919 },
  CLE:  { lat: 41.4117, lng: -81.8497 },
  IND:  { lat: 39.7173, lng: -86.2944 },
  CVG:  { lat: 39.0488, lng: -84.6678 },

  // West
  DEN:  { lat: 39.8617, lng: -104.6731 },
  APA:  { lat: 39.5701, lng: -104.8487 },
  ASE:  { lat: 39.2232, lng: -106.8687 },
  EGE:  { lat: 39.6426, lng: -106.9176 },
  JAC:  { lat: 43.6073, lng: -110.7378 },
  LAS:  { lat: 36.0801, lng: -115.1522 },
  LAX:  { lat: 33.9416, lng: -118.4085 },
  VNY:  { lat: 34.2098, lng: -118.4901 },
  SNA:  { lat: 33.6757, lng: -117.8682 },
  BUR:  { lat: 34.2007, lng: -118.3587 },
  SBA:  { lat: 34.4262, lng: -119.8415 },
  SFO:  { lat: 37.6213, lng: -122.3790 },
  SJC:  { lat: 37.3639, lng: -121.9289 },
  OAK:  { lat: 37.7213, lng: -122.2207 },
  PDX:  { lat: 45.5887, lng: -122.5975 },
  SEA:  { lat: 47.4502, lng: -122.3088 },
  BFI:  { lat: 47.5300, lng: -122.3019 },
  PHX:  { lat: 33.4373, lng: -112.0078 },
  SDL:  { lat: 33.6229, lng: -111.9106 },
  TUS:  { lat: 32.1161, lng: -110.9410 },
  ABQ:  { lat: 35.0402, lng: -106.6090 },
  SAF:  { lat: 35.6171, lng: -106.0892 },
  SAT:  { lat: 29.5337, lng: -98.4698 },
  AUS:  { lat: 30.1975, lng: -97.6664 },
  HOU:  { lat: 29.6454, lng: -95.2789 },
  IAH:  { lat: 29.9844, lng: -95.3414 },
  DAL:  { lat: 32.8471, lng: -96.8518 },
  DFW:  { lat: 32.8998, lng: -97.0403 },
  ADS:  { lat: 32.9686, lng: -96.8364 },
  TKI:  { lat: 33.1772, lng: -96.5907 },

  // Additional US airports (charter favorites)
  // Mountain West
  TEX:  { lat: 37.9536, lng: -107.9083 },  // Telluride
  HDN:  { lat: 40.4811, lng: -107.2178 },  // Hayden / Steamboat
  RIL:  { lat: 39.5263, lng: -107.7269 },  // Rifle / Glenwood Springs
  MTJ:  { lat: 38.5097, lng: -107.8942 },  // Montrose
  GJT:  { lat: 39.1224, lng: -108.5267 },  // Grand Junction
  SUN:  { lat: 43.5044, lng: -114.2961 },  // Hailey / Sun Valley
  BZN:  { lat: 45.7773, lng: -111.1602 },  // Bozeman
  GPI:  { lat: 48.3105, lng: -114.2557 },  // Glacier Park / Kalispell
  COD:  { lat: 44.5202, lng: -109.0238 },  // Cody
  BIL:  { lat: 45.8077, lng: -108.5429 },  // Billings
  IDA:  { lat: 43.5146, lng: -112.0708 },  // Idaho Falls
  BOI:  { lat: 43.5644, lng: -116.2228 },  // Boise
  SLC:  { lat: 40.7884, lng: -111.9778 },  // Salt Lake City
  HEB:  { lat: 40.4818, lng: -111.4290 },  // Heber City
  PVU:  { lat: 40.2192, lng: -111.7239 },  // Provo
  CDC:  { lat: 37.7010, lng: -113.0989 },  // Cedar City
  SGU:  { lat: 37.0908, lng: -113.5933 },  // St. George
  BJC:  { lat: 39.9088, lng: -105.1172 },  // Rocky Mountain Metro (Denver)
  GUC:  { lat: 38.5339, lng: -106.9333 },  // Gunnison
  AKO:  { lat: 40.1755, lng: -103.2222 },  // Akron CO
  TRK:  { lat: 39.3200, lng: -120.1397 },  // Truckee
  RNO:  { lat: 39.4991, lng: -119.7681 },  // Reno
  MMH:  { lat: 37.6240, lng: -118.8378 },  // Mammoth Lakes
  // PNW
  PAE:  { lat: 47.9063, lng: -122.2816 },  // Everett / Paine
  PSC:  { lat: 46.2647, lng: -119.1190 },  // Pasco / Tri-Cities
  YKM:  { lat: 46.5683, lng: -120.5444 },  // Yakima
  HIO:  { lat: 45.5404, lng: -122.9498 },  // Hillsboro
  TIW:  { lat: 47.2680, lng: -122.5783 },  // Tacoma Narrows
  // California secondary
  CCR:  { lat: 37.9897, lng: -122.0573 },  // Concord
  PAO:  { lat: 37.4611, lng: -122.1150 },  // Palo Alto
  RHV:  { lat: 37.3329, lng: -121.8195 },  // Reid-Hillview San Jose
  WVI:  { lat: 36.9356, lng: -121.7898 },  // Watsonville
  MRY:  { lat: 36.5870, lng: -121.8429 },  // Monterey
  PSP:  { lat: 33.8297, lng: -116.5067 },  // Palm Springs
  TRM:  { lat: 33.6262, lng: -116.1597 },  // Thermal / Jacqueline Cochran
  CRQ:  { lat: 33.1283, lng: -117.2802 },  // Carlsbad / McClellan-Palomar
  CMA:  { lat: 34.2113, lng: -119.0944 },  // Camarillo
  OXR:  { lat: 34.2008, lng: -119.2071 },  // Oxnard
  SMX:  { lat: 34.8989, lng: -120.4574 },  // Santa Maria
  SQL:  { lat: 37.5119, lng: -122.2495 },  // San Carlos
  HHR:  { lat: 33.9229, lng: -118.3352 },  // Hawthorne
  TOA:  { lat: 33.8034, lng: -118.3396 },  // Torrance / Zamperini
  LGB:  { lat: 33.8177, lng: -118.1517 },  // Long Beach
  ONT:  { lat: 34.0560, lng: -117.6010 },  // Ontario CA
  AJO:  { lat: 33.7080, lng: -116.8800 },  // Corona / Bermuda Dunes
  // Texas secondary
  HQZ:  { lat: 32.7470, lng: -96.5340 },   // Mesquite Metro
  CXO:  { lat: 30.3518, lng: -95.4144 },   // Conroe / Lone Star Exec
  EFD:  { lat: 29.6073, lng: -95.1587 },   // Ellington (Houston)
  SGR:  { lat: 29.6223, lng: -95.6566 },   // Sugar Land
  GKY:  { lat: 32.4140, lng: -97.0915 },   // Arlington
  FTW:  { lat: 32.8198, lng: -97.3624 },   // Fort Worth Meacham
  MAF:  { lat: 31.9425, lng: -102.2019 },  // Midland
  LBB:  { lat: 33.6636, lng: -101.8228 },  // Lubbock
  AMA:  { lat: 35.2194, lng: -101.7059 },  // Amarillo
  ELP:  { lat: 31.8073, lng: -106.3776 },  // El Paso
  CRP:  { lat: 27.7704, lng: -97.5012 },   // Corpus Christi
  HRL:  { lat: 26.2285, lng: -97.6544 },   // Harlingen
  BRO:  { lat: 25.9068, lng: -97.4259 },   // Brownsville
  MFE:  { lat: 26.1758, lng: -98.2386 },   // McAllen
  TYR:  { lat: 32.3540, lng: -95.4023 },   // Tyler
  GGG:  { lat: 32.3849, lng: -94.7115 },   // Longview
  // Florida + Southeast secondary
  SUA:  { lat: 27.1817, lng: -80.2211 },   // Stuart / Witham
  VRB:  { lat: 27.6556, lng: -80.4179 },   // Vero Beach
  FPR:  { lat: 27.4949, lng: -80.3683 },   // Fort Pierce
  X51:  { lat: 25.3253, lng: -80.2747 },   // Miami Homestead General Aviation
  TIX:  { lat: 28.5147, lng: -80.7995 },   // Titusville / Space Coast
  CRG:  { lat: 30.3363, lng: -81.5144 },   // Craig (Jacksonville)
  HEG:  { lat: 30.3009, lng: -81.8095 },   // Herlong (Jacksonville)
  GNV:  { lat: 29.6900, lng: -82.2718 },   // Gainesville
  OCF:  { lat: 29.1726, lng: -82.2241 },   // Ocala
  LAL:  { lat: 27.9889, lng: -82.0186 },   // Lakeland
  BCT:  { lat: 26.3785, lng: -80.1077 },   // Boca Raton
  HWO:  { lat: 26.0014, lng: -80.2407 },   // Hollywood / North Perry
  PMP:  { lat: 26.2470, lng: -80.1111 },   // Pompano Beach
  MTH:  { lat: 24.7261, lng: -81.0514 },   // Marathon
  CTY:  { lat: 30.3017, lng: -83.1019 },   // Cross City
  ECP:  { lat: 30.3589, lng: -85.7956 },   // Panama City NW Beaches
  PFN:  { lat: 30.2121, lng: -85.6828 },   // Panama City Bay County
  // NE / Mid-Atlantic secondary
  HTO:  { lat: 40.9595, lng: -72.2517 },   // East Hampton
  FOK:  { lat: 40.8438, lng: -72.6318 },   // Westhampton / Gabreski
  POU:  { lat: 41.6266, lng: -73.8842 },   // Poughkeepsie
  SWF:  { lat: 41.5041, lng: -74.1048 },   // Newburgh / Stewart
  OXC:  { lat: 41.4787, lng: -73.1352 },   // Waterbury-Oxford
  HVN:  { lat: 41.2637, lng: -72.8868 },   // New Haven / Tweed
  GON:  { lat: 41.3300, lng: -72.0451 },   // Groton / New London
  BDL:  { lat: 41.9389, lng: -72.6832 },   // Bradley / Hartford
  BAF:  { lat: 42.1577, lng: -72.7156 },   // Westfield / Barnes
  PSF:  { lat: 42.4267, lng: -73.2926 },   // Pittsfield
  SCH:  { lat: 42.8525, lng: -73.9289 },   // Schenectady
  FRG:  { lat: 40.7288, lng: -73.4134 },   // Republic (Long Island)
  CXY:  { lat: 40.2173, lng: -76.8517 },   // Capital City Harrisburg
  LNS:  { lat: 40.1217, lng: -76.2961 },   // Lancaster PA
  ABE:  { lat: 40.6521, lng: -75.4408 },   // Lehigh Valley
  MMU:  { lat: 40.7995, lng: -74.4148 },   // Morristown
  // Florida charter favorites
  MLB:  { lat: 28.1027, lng: -80.6457 },   // Melbourne
  PGD:  { lat: 26.9197, lng: -81.9905 },   // Punta Gorda
  FMY:  { lat: 26.5867, lng: -81.8631 },   // Fort Myers Page Field
  SRQ:  { lat: 27.3954, lng: -82.5544 },   // Sarasota
  VNC:  { lat: 27.0717, lng: -82.4404 },   // Venice
  // Misc useful
  ASE:  { lat: 39.2232, lng: -106.8687 },  // Aspen (duplicate guard)
  HXA:  { lat: 41.4640, lng: -90.5258 },   // Quad Cities
  PIA:  { lat: 40.6643, lng: -89.6932 },   // Peoria
  SPI:  { lat: 39.8441, lng: -89.6779 },   // Springfield IL
  CPS:  { lat: 38.5707, lng: -90.1561 },   // St. Louis Downtown
  TOL:  { lat: 41.5868, lng: -83.8079 },   // Toledo
  AOH:  { lat: 40.7066, lng: -84.0265 },   // Lima OH
  AKR:  { lat: 41.0374, lng: -81.4670 },   // Akron Fulton
  CAK:  { lat: 40.9161, lng: -81.4422 },   // Akron-Canton
  YNG:  { lat: 41.2607, lng: -80.6790 },   // Youngstown

  // Canada (Eastern)
  CYYZ: { lat: 43.6777, lng: -79.6248 },
  CYTZ: { lat: 43.6275, lng: -79.3961 },
  CYKZ: { lat: 43.8625, lng: -79.3700 },
  CYOW: { lat: 45.3225, lng: -75.6692 },
  CYUL: { lat: 45.4707, lng: -73.7407 },
  CYHU: { lat: 45.5175, lng: -73.4169 },
  CYQB: { lat: 46.7911, lng: -71.3933 },
  CYHZ: { lat: 44.8808, lng: -63.5086 },
  CYHM: { lat: 43.1736, lng: -79.9350 },   // Hamilton
  CYKF: { lat: 43.4608, lng: -80.3786 },   // Kitchener/Waterloo
  CYXU: { lat: 43.0356, lng: -81.1539 },   // London ON
  CYAM: { lat: 46.4847, lng: -84.5094 },   // Sault Ste Marie
  CYTS: { lat: 48.5697, lng: -81.3767 },   // Timmins
  CYQT: { lat: 48.3717, lng: -89.3239 },   // Thunder Bay
  CYSB: { lat: 46.6253, lng: -80.7989 },   // Sudbury
  CYYJ: { lat: 48.6469, lng: -123.4258 },  // Victoria
  CYVR: { lat: 49.1939, lng: -123.1844 },  // Vancouver
  CYXX: { lat: 49.0253, lng: -122.3611 },  // Abbotsford
  CYYC: { lat: 51.1139, lng: -114.0203 },  // Calgary
  CYEG: { lat: 53.3097, lng: -113.5800 },  // Edmonton
  CYWG: { lat: 49.9100, lng: -97.2399 },   // Winnipeg
  CYQR: { lat: 50.4319, lng: -104.6658 },  // Regina
  CYXE: { lat: 52.1708, lng: -106.6997 },  // Saskatoon
  CYYT: { lat: 47.6186, lng: -52.7519 },   // St. John's NL
  CYQM: { lat: 46.1122, lng: -64.6786 },   // Moncton
  CYFC: { lat: 45.8689, lng: -66.5375 },   // Fredericton
  CYSJ: { lat: 45.3161, lng: -65.8903 },   // Saint John
  CYZF: { lat: 62.4628, lng: -114.4403 },  // Yellowknife
  CYXY: { lat: 60.7095, lng: -135.0672 },  // Whitehorse

  // Mexico
  MMUN: { lat: 21.0365, lng: -86.8771 },   // Cancun
  MMMX: { lat: 19.4361, lng: -99.0719 },   // Mexico City Benito Juarez
  MMTO: { lat: 19.3370, lng: -99.5660 },   // Toluca (charter favorite)
  MMSD: { lat: 22.8743, lng: -109.7211 },  // San Jose del Cabo
  MMLP: { lat: 24.0727, lng: -110.3625 },  // La Paz
  MMPR: { lat: 20.6801, lng: -105.2542 },  // Puerto Vallarta
  MMZH: { lat: 17.6016, lng: -101.4606 },  // Ixtapa Zihuatanejo
  MMAA: { lat: 19.1361, lng: -96.1869 },   // Veracruz
  MMMD: { lat: 20.9370, lng: -89.6577 },   // Merida
  MMCZ: { lat: 20.5224, lng: -86.9255 },   // Cozumel
  MMGL: { lat: 20.5218, lng: -103.3110 },  // Guadalajara
  MMMY: { lat: 25.7785, lng: -100.1067 },  // Monterrey
  MMMM: { lat: 19.8500, lng: -101.0250 },  // Morelia
  MMTJ: { lat: 32.5411, lng: -116.9700 },  // Tijuana
  MMHO: { lat: 29.0958, lng: -111.0478 },  // Hermosillo
  MMCL: { lat: 24.7644, lng: -107.4747 },  // Culiacan
  MMMZ: { lat: 23.1614, lng: -106.2661 },  // Mazatlan
  MMCN: { lat: 27.3925, lng: -109.8333 },  // Ciudad Obregon
  MMTM: { lat: 22.2964, lng: -97.8658 },   // Tampico
  MMCV: { lat: 23.7029, lng: -98.9569 },   // Ciudad Victoria
  MMQT: { lat: 20.6173, lng: -100.1856 },  // Queretaro
  MMSP: { lat: 22.2542, lng: -100.9306 },  // San Luis Potosi
  MMAS: { lat: 21.7056, lng: -102.3175 },  // Aguascalientes
  MMLO: { lat: 20.9935, lng: -101.4811 },  // Leon/Bajio
  MMPN: { lat: 19.1581, lng: -98.3711 },   // Puebla
  MMOX: { lat: 17.0000, lng: -96.7264 },   // Oaxaca
  MMAN: { lat: 25.8656, lng: -100.2386 },  // Monterrey (Aeropuerto del Norte)
  MMNL: { lat: 25.7456, lng: -100.0044 },  // Nuevo Laredo
  MMRX: { lat: 16.7669, lng: -99.7539 },   // Acapulco
  MMVR: { lat: 19.4242, lng: -97.5125 },   // Tehuacan
  MMTP: { lat: 16.5618, lng: -93.0224 },   // Tuxtla Gutierrez
  MMCT: { lat: 24.5447, lng: -99.5708 },   // Chetumal
  MMTC: { lat: 25.5497, lng: -103.4106 },  // Torreon

  // Caribbean — Bahamas
  MYNN: { lat: 25.0389, lng: -77.4661 },   // Nassau
  MYGF: { lat: 26.5587, lng: -78.6956 },   // Freeport / Grand Bahama
  MYAM: { lat: 26.5114, lng: -77.0834 },   // Marsh Harbour
  MYEH: { lat: 25.4747, lng: -76.6835 },   // North Eleuthera
  MYEM: { lat: 25.2847, lng: -76.3309 },   // Governor's Harbour
  MYES: { lat: 24.6989, lng: -76.1769 },   // Staniel Cay
  MYEF: { lat: 25.0244, lng: -76.1664 },   // Exuma International
  MYAK: { lat: 26.5375, lng: -76.6839 },   // Andros / Congo Town
  MYAT: { lat: 21.4946, lng: -71.1389 },   // Treasure Cay
  MYBS: { lat: 24.2872, lng: -76.0331 },   // South Eleuthera (Cape Eleuthera)
  MYIG: { lat: 20.9750, lng: -73.6669 },   // Inagua
  MYAB: { lat: 26.7261, lng: -77.0822 },   // Sandy Point
  MYCB: { lat: 23.9667, lng: -77.5333 },   // Cat Island / New Bight
  MYRD: { lat: 22.0264, lng: -74.8275 },   // Rum Cay
  MYSM: { lat: 23.5128, lng: -75.7642 },   // San Salvador
  MYCC: { lat: 23.6800, lng: -75.5500 },   // Cat Cay
  MYBG: { lat: 25.0444, lng: -77.5439 },   // Great Harbour Cay

  // Caribbean — US territories
  TJSJ: { lat: 18.4394, lng: -66.0018 },   // San Juan
  TJBQ: { lat: 18.4949, lng: -67.1294 },   // Aguadilla
  TJPS: { lat: 18.0083, lng: -66.5631 },   // Ponce
  TJMZ: { lat: 18.2556, lng: -67.1485 },   // Mayaguez
  TJIG: { lat: 18.4567, lng: -66.0981 },   // Isla Grande, San Juan
  TIST: { lat: 18.3373, lng: -64.9734 },   // St. Thomas
  TISX: { lat: 17.7019, lng: -64.7986 },   // St. Croix

  // Caribbean — Cayman / Turks
  MWCR: { lat: 19.2928, lng: -81.3577 },   // Owen Roberts, Grand Cayman
  MWCB: { lat: 19.6870, lng: -79.8828 },   // Cayman Brac
  MBPV: { lat: 21.7736, lng: -72.2658 },   // Providenciales (Turks & Caicos)
  MBGT: { lat: 21.4444, lng: -71.1422 },   // Grand Turk

  // Caribbean — Cuba
  MUHA: { lat: 22.9892, lng: -82.4091 },   // Havana
  MUVR: { lat: 23.0344, lng: -81.4353 },   // Varadero
  MUCA: { lat: 21.4203, lng: -77.8483 },   // Camaguey
  MUCC: { lat: 22.4949, lng: -78.7861 },   // Cayo Coco

  // Caribbean — Dominican Republic / Haiti
  MDSD: { lat: 18.4297, lng: -69.6689 },   // Santo Domingo Las Americas
  MDST: { lat: 19.4061, lng: -70.6047 },   // Santiago
  MDPP: { lat: 19.7578, lng: -70.5700 },   // Puerto Plata
  MDPC: { lat: 18.5675, lng: -68.3633 },   // Punta Cana
  MDLR: { lat: 18.4500, lng: -68.9117 },   // La Romana
  MDSM: { lat: 18.5044, lng: -69.7350 },   // Higuero (private)
  MTPP: { lat: 18.5800, lng: -72.2925 },   // Port-au-Prince

  // Caribbean — Jamaica
  MKJP: { lat: 17.9357, lng: -76.7875 },   // Kingston Norman Manley
  MKJS: { lat: 18.5037, lng: -77.9134 },   // Montego Bay
  MKBS: { lat: 18.4108, lng: -77.6597 },   // Boscobel
  MKTP: { lat: 17.9886, lng: -76.8233 },   // Kingston Tinson Pen

  // Caribbean — Leeward / Windward
  TNCM: { lat: 18.0410, lng: -63.1089 },   // St. Maarten
  TNCB: { lat: 12.1314, lng: -68.2693 },   // Bonaire
  TNCA: { lat: 12.5014, lng: -70.0152 },   // Aruba
  TNCC: { lat: 12.1889, lng: -68.9598 },   // Curacao
  TNCE: { lat: 17.4965, lng: -62.9794 },   // Eustatius
  TNCS: { lat: 17.6453, lng: -63.2202 },   // Saba
  TFFG: { lat: 18.0995, lng: -63.0472 },   // St. Martin Grand Case
  TFFJ: { lat: 17.9043, lng: -62.8436 },   // St. Barths
  TFFF: { lat: 14.5910, lng: -61.0032 },   // Martinique Aime Cesaire
  TFFR: { lat: 16.2654, lng: -61.5316 },   // Pointe-a-Pitre, Guadeloupe
  TGPY: { lat: 12.0042, lng: -61.7862 },   // Grenada
  TLPL: { lat: 13.7383, lng: -60.9527 },   // St. Lucia (Castries / George Charles)
  TLPC: { lat: 13.7497, lng: -60.9525 },   // St. Lucia Castries
  TBPB: { lat: 13.0747, lng: -59.4925 },   // Barbados
  TVSA: { lat: 12.7000, lng: -61.2500 },   // Canouan
  TVSM: { lat: 12.5853, lng: -61.4147 },   // Mustique
  TVSU: { lat: 12.6233, lng: -61.3922 },   // Union Island
  TVSV: { lat: 13.1444, lng: -61.2108 },   // St. Vincent
  TVSC: { lat: 13.3344, lng: -61.1944 },   // Bequia
  TTPP: { lat: 10.5953, lng: -61.3372 },   // Trinidad Piarco
  TTCP: { lat: 11.1497, lng: -60.8322 },   // Tobago
  TAPA: { lat: 17.1367, lng: -61.7928 },   // Antigua
  TUPJ: { lat: 18.4453, lng: -64.5430 },   // Tortola, BVI
  TKPK: { lat: 17.3114, lng: -62.7187 },   // St. Kitts
  TQPF: { lat: 18.2056, lng: -63.0556 },   // Anguilla
  TDPD: { lat: 15.5469, lng: -61.3000 },   // Dominica Douglas-Charles
  TDCF: { lat: 15.3092, lng: -61.3950 },   // Dominica Canefield

  // Central America
  MPTO: { lat: 9.0714, lng: -79.3835 },    // Panama City Tocumen
  MPMG: { lat: 8.9737, lng: -79.5556 },    // Panama Marcos Gelabert (Albrook)
  MPHO: { lat: 8.9156, lng: -79.5994 },    // Howard / Panama Pacifico
  MRLB: { lat: 10.5933, lng: -85.5444 },   // Liberia, Costa Rica
  MROC: { lat: 9.9939, lng: -84.2089 },    // San Jose Juan Santamaria
  MRPV: { lat: 9.9569, lng: -84.1397 },    // San Jose Tobias Bolanos
  MNMG: { lat: 12.1413, lng: -86.1683 },   // Managua
  MGGT: { lat: 14.5836, lng: -90.5275 },   // Guatemala City La Aurora
  MHTG: { lat: 14.0608, lng: -87.2173 },   // Tegucigalpa
  MHLM: { lat: 15.4525, lng: -87.9236 },   // San Pedro Sula
  MHRO: { lat: 16.3164, lng: -86.5230 },   // Roatan
  MSLP: { lat: 13.4408, lng: -89.0556 },   // San Salvador
  MZBZ: { lat: 17.5391, lng: -88.3081 },   // Belize City

  // South America — Northern
  SVMI: { lat: 10.6031, lng: -66.9911 },   // Caracas Maiquetia
  SVBC: { lat: 10.4514, lng: -68.0814 },   // Valencia, VE
  SVMC: { lat: 10.5582, lng: -71.7278 },   // Maracaibo
  SKBO: { lat: 4.7016, lng: -74.1469 },    // Bogota El Dorado
  SKCG: { lat: 10.4424, lng: -75.5130 },   // Cartagena
  SKMR: { lat: 8.8233, lng: -75.8258 },    // Monteria
  SKRG: { lat: 6.1645, lng: -75.4231 },    // Medellin Jose Maria Cordova
  SKMD: { lat: 6.2204, lng: -75.5906 },    // Medellin Olaya Herrera
  SKCL: { lat: 3.5432, lng: -76.3816 },    // Cali
  SKSP: { lat: 12.5836, lng: -81.7112 },   // San Andres
  SEQM: { lat: -0.1292, lng: -78.3575 },   // Quito Mariscal Sucre
  SEGU: { lat: -2.1574, lng: -79.8836 },   // Guayaquil
  SPJC: { lat: -12.0219, lng: -77.1143 },  // Lima Jorge Chavez
  SPZO: { lat: -13.5358, lng: -71.9388 },  // Cusco
  SLLP: { lat: -16.5133, lng: -68.1925 },  // La Paz El Alto
  SLVR: { lat: -17.6448, lng: -63.1354 },  // Santa Cruz Viru Viru

  // South America — Southern Cone / Brazil
  SBGR: { lat: -23.4356, lng: -46.4731 },  // Sao Paulo Guarulhos
  SBSP: { lat: -23.6266, lng: -46.6553 },  // Sao Paulo Congonhas
  SBGL: { lat: -22.8099, lng: -43.2506 },  // Rio Galeao
  SBRJ: { lat: -22.9105, lng: -43.1631 },  // Rio Santos Dumont
  SBJR: { lat: -22.9874, lng: -43.3702 },  // Rio Jacarepagua
  SBBR: { lat: -15.8697, lng: -47.9208 },  // Brasilia
  SBSV: { lat: -12.9086, lng: -38.3225 },  // Salvador
  SBRF: { lat: -8.1265, lng: -34.9236 },   // Recife
  SBFZ: { lat: -3.7763, lng: -38.5326 },   // Fortaleza
  SBBE: { lat: -1.3792, lng: -48.4763 },   // Belem
  SBMN: { lat: -3.0386, lng: -60.0497 },   // Manaus
  SBCT: { lat: -25.5285, lng: -49.1758 },  // Curitiba
  SBFL: { lat: -27.6705, lng: -48.5525 },  // Florianopolis
  SBPA: { lat: -29.9939, lng: -51.1714 },  // Porto Alegre
  SBCY: { lat: -15.6529, lng: -56.1167 },  // Cuiaba
  SAEZ: { lat: -34.8222, lng: -58.5358 },  // Buenos Aires Ezeiza
  SABE: { lat: -34.5592, lng: -58.4156 },  // Buenos Aires Aeroparque
  SADF: { lat: -34.4533, lng: -58.5897 },  // San Fernando (charter)
  SAME: { lat: -32.8317, lng: -68.7929 },  // Mendoza
  SACO: { lat: -31.3236, lng: -64.2080 },  // Cordoba
  SCEL: { lat: -33.3928, lng: -70.7858 },  // Santiago, Chile
  SCDA: { lat: -18.3486, lng: -70.3386 },  // Arica
  SUMU: { lat: -34.8384, lng: -56.0308 },  // Montevideo
  SUPU: { lat: -34.8556, lng: -55.0944 },  // Punta del Este
  SGAS: { lat: -25.2400, lng: -57.5200 },  // Asuncion

  // South America — French Guiana / Suriname / Guyana
  SOCA: { lat: 4.8198, lng: -52.3604 },    // Cayenne
  SMJP: { lat: 5.4528, lng: -55.1878 },    // Paramaribo
  SYCJ: { lat: 6.4985, lng: -58.2541 },    // Georgetown
};

// Dynamic supplement to the bundled coord database. Populated at
// runtime from `flightaware-airports/*` (written by the FA cron whenever
// it sees a new airport). This is how the board self-heals when our
// bundled DB doesn't have an airport — instead of needing a code change,
// the next time the cron flies a trip involving that airport, its
// coords land here.
//
// Keys are uppercase airport codes (typically 4-letter ICAO from FA).
// We don't gate on the airport actually being in our routes — every
// airport FA has ever told us about ends up here.
const DYNAMIC_COORDS = new Map();

/**
 * Add (or update) a coords entry from a dynamic source (typically the
 * FA cron's cache). Called by the FlightBoard's subscription effect
 * once the Firestore listener fires.
 */
export function addDynamicCoords(code, lat, lng) {
  if (!code || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  DYNAMIC_COORDS.set(String(code).toUpperCase().trim(), { lat, lng });
}

/**
 * Look up airport coordinates. Tries the code as given, then with
 * K-prefix removed (US ICAO → FAA), then with K-prefix added.
 * Falls back to the dynamic cache populated from FlightAware.
 * Returns { lat, lng } or null if unknown.
 */
export function lookupCoords(code) {
  if (!code) return null;
  const c = String(code).toUpperCase().trim();
  if (COORDS[c]) return COORDS[c];
  if (c.length === 4 && c.startsWith('K') && COORDS[c.slice(1)]) return COORDS[c.slice(1)];
  if (c.length === 3 && COORDS['K' + c]) return COORDS['K' + c];
  // Dynamic fallback — same prefix tolerance.
  if (DYNAMIC_COORDS.has(c)) return DYNAMIC_COORDS.get(c);
  if (c.length === 4 && c.startsWith('K') && DYNAMIC_COORDS.has(c.slice(1))) return DYNAMIC_COORDS.get(c.slice(1));
  if (c.length === 3 && DYNAMIC_COORDS.has('K' + c)) return DYNAMIC_COORDS.get('K' + c);
  return null;
}

export default COORDS;
