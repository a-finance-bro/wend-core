/**
 * English given-name nicknames, as canonical -> nickname pairs.
 *
 * Feeds nameMatch (src/lib/nodes/name-match.ts): "Bill Smith" and
 * "William Smith" are plausibly the same person, and before this table the
 * matcher could not see it, so the identity question was never RAISED and the
 * graph kept both. The table only ever widens the FIRST-name comparison, and
 * only to "compatible", never to a full match: the anchor rule in nameMatch
 * still demands a fully-matching surname, so a nickname alone can never merge
 * anyone. It raises the question; the user answers it (contract 033).
 *
 * Direct pairs only, by design. "liz" and "beth" are both nicknames of
 * "elizabeth", but the table does not bridge THROUGH the canonical name:
 * sibling nicknames are a weaker signal, and a false identity question
 * outranks a real one the way a false industry match outranks a good semantic
 * hit. If a canonical-sibling bridge is ever wanted, it is a second predicate,
 * not a widening of this one.
 *
 * Plain data and pure functions, no imports, so the hosted app, the Mac
 * sidecar build and the wend-core export all share this one file. There is
 * deliberately NO second copy anywhere: the engine reaches nameMatch through
 * src/lib/identity/candidate-sets.ts in the local build, so one artifact
 * serves both runtimes.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE
 *
 * The corpus below is the names.csv dataset from carltonnorthern/nicknames,
 * Apache License 2.0, fetched 2026-08-21 at commit
 * 1524308b6859f04335693b76de86f349dc5b78da (2,827 canonical->nickname rows,
 * 1,232 canonical names). Our transformations, recorded here: lowercased,
 * periods stripped from the three dotted initialisms (k.c., l.r., l.b.),
 * exact self-pairs dropped, rows grouped per canonical name and packed as
 * "canonical:nick,nick;canonical:nick" for size.
 *
 *                              Apache License
 *                        Version 2.0, January 2004
 *                     http://www.apache.org/licenses/
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy
 * of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 */

/** "canonical:nick,nick;canonical:nick,..." parsed once at module load. */
const PACKED_CORPUS: string = [
    "aaron:erin,ron,ronnie;abbigail:abbe,abbey,abbi,abbie,abby,gail,nabby",
    "abbigale:abbe,abbey,abbi,abbie,abby,gail,nabby;abednego:bedney;abel:ab,abe,eb,ebbie;abiel:ab",
    "abigail:abbe,abbey,abbi,abbie,abby,gail,nabby;abigale:abbe,abbey,abbi,abbie,abby,gail,nabby",
    "abijah:ab,bige;abner:ab;abraham:ab,abe;abram:ab,abe;absalom:ab,abbie,app;ada:addy,adie",
    "adaline:ada,addy,adie,delia,dell,lena;addison:addie,addy;adela:adie,della",
    "adelaide:addy,adele,adie,dell,della,heidi;adelbert:albert,bert,del,delbert;adele:addy,dell",
    "adeline:ada,addy,delia,dell,lena;adelphia:addy,adele,dell,delphia,philly",
    "adena:adina,deena,dena,dina;adolphus:ado,adolph,dolph;adrian:rian;adriane:riane",
    "adrienne:addie,enne,rienne;agatha:aga,aggy;agnes:aggy,inez,nessa;aileen:allie,lena;alan:al",
    "alanson:al,lanson;alastair:al;alazama:ali;albert:al,bert;alberta:allie,bert,bertie;aldo:al",
    "aldrich:rich,riche,richie;aleksandr:alek,alex;aleva:leve,levy;alex:al;alexa:alex,lexi",
    "alexander:al,alec,alex,sandy;alexandra:alex,alla,sandra,sandy",
    "alexandria:alex,alexander,alla,drina,sandra;alexis:alex,lexi;alfonse:al;alfred:al,fred,freddy",
    "alfreda:alfy,freda,freddy,frieda;algernon:algy;alice:allie,elsie,lisa;alicia:allie,elsie,lisa",
    "aline:adeline;alison:ali,allie;alixandra:alix;allan:al,alan,allen;allen:al,alan,allan",
    "allisandra:ali,allie,ally;allison:ali,allie,ally;allyson:ali,allie,ally;allyssa:ali,allie,ally",
    "almena:ali,allie,ally,mena;almina:minnie;almira:myra;alonzo:al,lon,lonzo;alphinias:alphus",
    "althea:ally;alverta:vert,virdie;alyssa:al,ally,lissia;alzada:zada;amanda:manda,mandy",
    "ambrose:brose;amelia:amy,emily,mel,millie;amos:moses;anastasia:ana,stacy;anderson:andy",
    "andre:drea;andrea:andi,andrew,andy,drea,rea;andrew:andy,drew,randy;andriane:ada,adri,rienne",
    "angela:angel,angie;angelica:angel,angelika,angelique,angie;angelina:angel,angie,lina",
    "ann:annie,nan;anna:ann,anne,annie,nan;anne:ann,annie,nan;annette:anna,nettie;annie:ann,anna",
    "anselm:ance,anse,ansel,selma;anthony:ant,tony;antoinette:ann,netta,tony;antonia:ann,netta,tony",
    "antonio:ant,tony;appoline:appie,appy;aquilla:quil,quillie;ara:arry,belle",
    "arabella:ara,arry,bella,belle;arabelle:ara,arry,bella,belle;araminta:armida,middie,minty,ruminta",
    "archibald:archie;archilles:kill,killis;ariadne:ari,arie;ariana:ari;arianna:ari;ariel:ari",
    "arielle:arie;aristotle:telly;arizona:ona,onie;arlene:arly,lena;armanda:mandy;armena:arry,mena",
    "armilda:milly;arminda:mindie;arminta:minite,minnie;arnold:arnie;aron:erin,ron,ronnie",
    "artelepsa:epsey;artemus:art;arthur:art;arthusa:thursa;arzada:zaddi;asahel:asa;asaph:asa",
    "asenath:assene,natty,sene;ashley:ash,ashly,leah,lee;aubrey:bree;audrey:audree,dee;august:gus",
    "augusta:aggy,gatsy,gussie,tina;augustina:aggy,gatsy,gussie,tina;augustine:august,austin,gus",
    "augustus:august,austin,gus;aurelia:aurilla,ora,orilla,ree,rilly;aurora:rory;avarilla:rilla",
    "axel:ax;azariah:aze,riah;bab:barby;babs:bab,barbara,barby;barbara:bab,babs,barbie,barby,bobbie",
    "barbery:barbara;barbie:barbara;barnabas:barney;barney:barnabas;barrett:barry;bart:bartholomew",
    "bartholomew:bart,bartel,bat,mees,meus;barticus:bart;bazaleel:basil;bea:beatrice",
    "beatrice:bea,trisha,trix,trixie;becca:beck;beck:becky;bedelia:bridgit,delia;belinda:belle,linda",
    "bella:arabella,belle,isabella;ben:benji,bennie,benny;benedict:ben,bennie",
    "benjamin:ben,benjy,bennie,benny,jamie;benjy:benjamin;bennett:ben,bennie,benny",
    "bernard:barney,berney,bernie,berny;berney:bernie;bert:bertie,bob,bobby;bertha:bert,bertie,birdie",
    "bertram:bert;bertrand:randy;bess:bessie;bessie:bess;beth:betsy,betty,elizabeth",
    "bethena:beth,thaney;beverly:bev;bezaleel:zeely;biddie:biddy",
    "bill:billy,fred,robert,william,willie;billy:fred,robert,william;blanche:bea;bob:rob,robert",
    "bobby:bob,rob;boetius:bo;brad:bradford,ford;bradford:brad,ford;bradley:brad;brady:brody",
    "breanna:bree,bri;breeanna:bree;brenda:brandy;brian:bryan,bryant;briana:bri;brianna:bri",
    "bridget:biddie,biddy,bridgie,bridie;brittany:britt,brittnie;brittney:britt,brittnie",
    "broderick:brady,brody,rick,ricky,rod;brooklyn:brook,brooke;bryanna:ana,anna,bri,briana,brianna",
    "bryant:bry,bryan;caitlin:cait,caity;caitlyn:cait,caity;caldonia:calliedona;caleb:cal",
    "california:callie;calista:kissy;callie:cal;calpurnia:cally;calvin:cal,vin,vinny",
    "cameron:cam,ron,ronny;camila:cami,mila;camile:cammie;camille:cammie,millie;campbell:cam",
    "candace:candy,dacey;carla:carly,karla;carlotta:lottie;carlton:carl;carmellia:mellia;carmelo:melo",
    "carmon:cammie,carm,charm;carol:carolann,carole,caroline,carri,carrie,cassie,kara,kari,lynn",
    "carolann:carol,carole;caroline:carol,carole,carrie,cassie,lynn;carolyn:carrie,cassie,lynn",
    "carrie:cassie;carthaette:etta,etty;casey:kc;casper:jasper;cassandra:cassie,sandra,sandy",
    "cassidy:cass,cassie;cassie:cass;caswell:cass",
    "catherine:casey,cassie,cathy,kathy,katy,kay,kit,kittie,lena,trina",
    "cathleen:casey,cassie,cathy,kathy,katy,kay,kit,kittie,lena,trina;cathy:catherine,cathleen,kathy",
    "cecilia:celia,cissy;cedric:ced,rick,ricky;celeste:celia,lessie;celinda:linda,lindy,lynn",
    "charity:chat;charles:carl,charlie,chick,chuck;charlie:charles,chuck",
    "charlotte:char,lotta,lottie,sherry;chauncey:chan;chelsea:chels,chelsie;chelsey:chelsie",
    "cheryl:cher;chesley:chet;chester:chet;chet:chester;chick:caroline,charlotte,chuck;chloe:clo",
    "chris:kris;christa:chris;christian:chris,kit",
    "christiana:ann,chris,christy,crissy,kris,kristy,tina;christiano:chris",
    "christina:chris,chrissy,christy,crissy,kris,kristy,tina",
    "christine:chris,chrissy,christy,crissy,kris,kristy,tina;christoffer:chris;christoph:chris",
    "christopher:chris,kit;christy:crissy;cicely:cilla;cinderella:arilla,cindy,rella,rilla",
    "cindy:cinderella;claire:clair,clara,clare;clara:clarissa;clare:clara;clarence:clair,clare",
    "clarinda:clara;clarissa:cissy,clara;claudia:claud;cleatus:cleat;clement:clem",
    "clementine:clem,clement;cliff:clifford;clifford:cliff,ford;clifton:cliff,tony;cole:colie",
    "colton:colt;columbus:clum;con:conny;conrad:con,conny;constance:connie;cooper:coop",
    "cordelia:cordy,delia;corey:coco,cordy,ree;corinne:cora,ora",
    "cornelia:cornie,corny,nelia,nelle,nelly;cornelius:con,conny,corny,neil,niel;cory:coco,cordy,ree",
    "courtney:court,curt;crystal:chris,crys,stal,tal;curtis:curt;cynthia:cindy,cintha",
    "cyrenius:cene,cy,renius,serene,swene;cyrus:cy;dahl:dal;dalton:dahl,dal;dan:danny",
    "daniel:dan,dann,danny;danielle:dani,ellie;danny:daniel;daphne:daph,daphie;darlene:darry,lena",
    "dave:davey;david:dave,davey,day;daycia:dacia,daisha;deanna:dee,deedee;deanne:ann,dee",
    "debbie:deb,debby,deborah,debra;debby:deb;debora:deb,debbie,debby;deborah:deb,debbie,debby",
    "debra:deb,debbie;deidre:deedee;delbert:bert,del;delia:cordelia,delius,fidelia",
    "delilah:dell,della,lil,lila;deliverance:della,delly,dilly;della:adela,adelaide,delilah,dell",
    "delores:dee,dell,della,lola,lolly;delpha:philadelphia;delphine:del,delf,delphi",
    "demaris:dea,maris,mary;demerias:dea,maris,mary;democrates:mock;denise:dee;dennis:dennie,denny",
    "dennison:dennis,denny;derek:derrek,rick,ricky;derick:rick,ricky;derrick:eric,rick,ricky",
    "deuteronomy:duty;diana:di,dicey,didi;diane:di,dian,dianne,dicey,didi;dicey:dicie",
    "dick:richard,rick;dickson:dick;domenic:dom,nic;dominic:dom,nic;dominick:dom,nick,nicky",
    "dominico:dom;don:donnie,donny;donald:don,donnie,donny,dony;donato:don;donna:dona",
    "donovan:don,donnie,donny,dony;dorcus:darkey;dorinda:dora,dorothea;doris:dora;dorothea:doda,dora",
    "dorothy:dolly,dora,dortha,dot,dottie,dotty;dotha:dotty;dotty:dot;douglas:doug;drusilla:silla",
    "duncan:dunk;dustin:dusty;earnest:ernestine,ernie;ebbie:eb;ebenezer:eb,ebbie,eben;eddie:ed",
    "eddy:ed;edgar:ed,eddie,eddy;edith:edie,edye;edmond:ed,eddie,eddy;edmund:ed,eddie,eddy,ned,ted",
    "edna:edny;eduardo:ed,eddie,eddy;edward:ed,eddie,eddy,ned,ted,teddy;edwin:ed,eddie,eddy,ned,win",
    "edwina:edwin;edyth:edie,edye;edythe:edie,edye;egbert:bert,burt;eighta:athy;eileen:helen",
    "elaine:helen,lainie;elbert:albert,bert;elbertson:bert,elbert;eldora:dora",
    "eleanor:elaine,ellen,ellie,lanna,lenora,nelly,nora;eleazer:lazar;elena:helen",
    "eliana:ella,elle,ellie;elias:eli,lee,lias;elijah:eli,lige;eliphalel:life;eliphalet:left",
    "elisa:lisa;elisha:eli,lish;eliza:elizabeth",
    "elizabeth:bess,bessie,beth,betsy,betty,eliza,lib,libby,lisa,liz,liza,lizzie,lizzy;ella:el,ellen",
    "ellen:helen,nell,nellie;ellender:ellen,helen,nellie;ellie:elly;ellswood:elsey;elminie:minnie",
    "elmira:ellie,elly,mira;elnora:nora;eloise:heloise,louise;elouise:louise;elsie:elsey",
    "elswood:elsey;elvira:elvie;elwood:woody;elysia:lisa,lissa;elze:elsey;emanuel:manny,manuel",
    "emeline:em,emily,emma,emmy,milly;emil:em,emily;emilia:em,emmy,millie",
    "emily:em,emma,emmy,mel,millie;emma:em,emmy;emmanuel:manny,manuel",
    "epaphroditius:dite,ditus,dyce,dyche,eppa;ephraim:eph;erasmus:rasmus,raze;eric:rick,ricky",
    "erick:eric,rick,ricky;erik:eric,rick,ricky;ernest:ernie;ernestine:erna,ernest,teeny,tina",
    "erwin:irwin;eseneth:senie;essy:es;estella:essy,stella;estelle:essy,stella;esther:essie,hester",
    "eudicy:dicey;eudora:dora;eudoris:dosie,dossie;eugene:gene;eunice:nicie;euphemia:effie,effy",
    "eurydice:dicey;eustacia:stacia,stacy;eva:eve;evaline:eva,eve,lena;evangeline:ev,evan,vangie",
    "evelyn:ev,eve,evelina;experience:exie;ezekiel:ez,zeke;ezideen:ez;ezra:ez;faith:fay",
    "fallon:fal,falcon,fall,fallie,fally,falon,lon,lonnie;felicia:fel,feli,felix;felicity:flick,tick",
    "feltie:felty;ferdinand:ferdie,fred,freddie,freddy;ferdinando:ferdie,fred,nando;fidelia:delia",
    "fionna:fiona;flora:florence;florence:flo,flora,flossy;floyd:lloyd;fran:frannie",
    "frances:cissy,fanny,fran,francie,frankie,frannie,franniey,franny,sis;francie:francine",
    "francine:fran,francie,frannie,franniey,franny;francis:fran,frank,frankie;frank:frankie,franky",
    "frankie:francis,frank;franklin:fran,frank;franklind:fran,frank;fred:freddie,freddy;freda:frieda",
    "frederica:erica,erika,freddy,frederick,rickey",
    "frederick:derick,erick,fred,freddie,freddy,fritz,rick,ricky",
    "fredericka:ericka,freda,freddy,frieda,ricka,rickey;frieda:fred,freddie,freddy;gabriel:gabby,gabe",
    "gabriella:ella,gabby;gabrielle:ella,gabby;gareth:gare,gary",
    "garrett:barrett,gare,garratt,garret,garry,gary,jerry,rhett;garrick:garri",
    "genevieve:eve,jean,jenny;geoffrey:geoff,jeff;george:georgie;georgia:georgie;georgiana:georgia",
    "georgine:george;gerald:gerry,jerry;geraldine:dina,gerri,gerrie,gerry,jerry;gerhardt:gay",
    "gertie:gert,gertrude;gertrude:gert,gertie,trudy;gilbert:bert,gil,wilber;giovanni:gio;glenn:glen",
    "gloria:glory;governor:govie;grace:gracie;grayson:gray;greenberry:berry,green;greggory:gregg",
    "gregory:gory,greg;gretchen:margaret;griselda:grissel;gum:monty;gus:gussie;gustavus:gus,gussie",
    "gwen:wendy;gwendolyn:gwen,wendy;hailey:haylee,hayley;hamilton:ham;hannah:anna,nan,nanny",
    "harold:hal,hap,haps,harry;harriet:hattie;harrison:hap,haps,harry;harry:hap,haps,harold,henry",
    "haseltine:hassie;haylee:hailey,hayley;hayley:hailey,haylee;heather:hetty",
    "helen:ella,ellen,ellie,lena;helena:aileen,eileen,elaine,eleanor,ellen,lena,nell,nellie",
    "helene:ella,ellen,ellie,lena;heloise:eloise,elouise,lois",
    "henrietta:etta,etty,hank,henny,nettie,retta;henry:hal,hank,hap,haps,harry;hephsibah:hipsie",
    "hepsibah:hipsie;herbert:bert,herb;herman:dutch,harman;hermione:hermie;hester:esther,hessy,hetty",
    "hezekiah:hez,hy,kiah;hillary:hilary;hipsbibah:hipsie;hiram:hy;honora:honey,nora,norah,norry",
    "hopkins:hop,hopp;horace:horry;hortense:harty,tensey;hosea:hosey,hosie;howard:hal,howie",
    "hubert:bert,hub,hugh;ian:john;ignatius:iggy,nace,nate,natius;ignatzio:iggy,nace,naz",
    "immanuel:emmanuel,manuel;india:indie,indy;inez:agnes;iona:onnie;irene:rena;irvin:irving",
    "irving:irv;irwin:erwin;isaac:ike,zeke;isabel:bell,bella,belle,ib,issy,nib,nibby,tibbie",
    "isabella:bella,belle,ib,issy,nib,nibby,tibbie;isabelle:bella,belle,ib,issy,nib,nibby,tibbie",
    "isadora:dora,issy;isadore:izzy;isaiah:zadie,zay;isidore:izzy;iva:ivy;ivan:john;jack:jackie",
    "jackson:jack;jacob:jaap,jake,jay;jacobus:jacob;jacqueline:jack,jackie,jacqui",
    "jahoda:hoda,hodie,hody;jakob:jake",
    "jalen:al,alen,haylen,jaelin,jaelyn,jailyn,jay,jaye,jaylin,jaylyn,len,lennie,lenny",
    "james:jamie,jem,jim,jimmie,jimmy;jamey:james,jamie;jamie:james;jane:janie,jean,jennie,jessie",
    "janet:jan,jessie;janice:jan;jannett:nettie;jasmine:jas,jazz,jazzy;jason:jase,jay",
    "jasper:casper,jap;jayme:jay;jean:jane,jeannie;jeanette:janet,jean,jessie,nettie",
    "jeanne:jane,jeannie;jebadiah:jeb;jedediah:diah,dyer,jed;jedidiah:diah,dyer,jed;jefferey:jeff",
    "jefferson:jeff,sonny;jeffery:jeff;jeffrey:geoff,jeff;jehiel:hiel;jehu:gee,hugh;jemima:mima",
    "jennet:jenn,jenny,jessie;jennie:jen,jenny;jennifer:jen,jenn,jenni,jennie,jenny",
    "jeremiah:jereme,jerry;jeremy:jez,jezza;jerita:rita;jerry:geraldine,geri,gerry,jereme;jesse:jess",
    "jessica:jess,jessie;jessie:jane,janet,jess;jillian:jill;jim:jimmie;jimmie:jim,jimmy;jincy:jane",
    "jinsy:jane;joan:jo,nonie;joann:jo;joanna:hannah,jo,joan,jodi,jody;joanne:jo;jocelyn:jo,joss",
    "jody:jo;joe:joey;joey:joe;johann:john;johanna:jo;johannah:hannah,jo,joan,jody,nonie",
    "johannes:john,johnny,jonathan;john:ian,jack,jock,johnny,jon,jonnie,jonny",
    "johnathan:john,johnathon,johny,jon,jonathan,jonathon,jonnie,jonny,nathan",
    "johnathon:john,johnathan,johny,jon,jonathan,jonathon,jonnie,jonny;jon:john,johnny,jonnie,jonny",
    "jonathan:john,johnathan,johnathon,johny,jon,jonathon,jonnie,jonny,nathan",
    "jonathon:john,johnathan,johnathon,johny,jon,jonathan,jonnie,jonny;jordan:jordy",
    "joseph:jody,joe,joey,jos;josephine:fina,jo,jody,joey,josey,josie;josetta:jettie;josey:josophine",
    "joshua:joe,jos,josh;josiah:jos;josophine:jo,joey,josey;joyce:joy;juanita:nettie,nita",
    "judah:jude,juder;judith:juda,jude,judi,judie,judy;judson:jud,sonny;judy:judith",
    "julia:jill,jules,julie;julian:jule,jules;julias:jule,jules;julie:jule,jules,julia;june:junius",
    "junior:jr,june,junie;justin:justina,juston,justus;kaitlin:kait,kaitie;kaitlyn:kait,kaitie",
    "kaitlynn:kait,kaitie;kalli:cali,kali;kameron:kam;karla:carla,carly;kasey:kc",
    "katarina:catherine,tina;kate:kay;katelin:kate,kay,kaye;katelyn:kate,kay,kaye",
    "katherine:cassie,cathy,kate,kathy,katie,katy,kay,kaye,kit,kittie,lena,trina",
    "kathleen:cassie,cathy,kathy,katy,kay,kit,kittie,lena,trina;kathryn:kate,kathy,katie",
    "katia:kate,katie;katy:kate,kathy,katie;kayla:kay;kelley:kelli,kellie,kelly;kendall:ken,kenny",
    "kendra:kay,kenj,kenji,kenny;kendrick:ken,kenny;kendrik:ken,kenny;kennedy:ken,kenny",
    "kenneth:ken,kendrick,kenny;kenny:ken,kenneth;kent:ken,kendrick,kenny;kerry:kerri;kevin:kev",
    "keziah:kizza,kizzie;kim:kimmy;kimberley:kim,kimberli,kimberly;kimberly:kim,kimberley,kimberli",
    "kingsley:king;kingston:king;kit:kittie;kris:chris;kristel:kris;kristen:chris;kristin:chris",
    "kristina:christina,kris,krissy,tina;kristine:chris,christy,crissy,kris,kristy,tina",
    "kristofer:chris,kris;kristoffer:chris,kris;kristopher:chris,kris;kristy:chris;kymberly:kym",
    "lafayette:fate,laffie;lamont:monty;laodicia:cenia,dicy;larry:laurence,lawrence",
    "latisha:tish,tisha;laura:laurie,lori;laurel:laurie;lauren:laurie,ren",
    "laurence:larry,lon,lonny,lorne,lorry;laurinda:laura,lawrence;lauryn:laurie;laveda:veda",
    "laverne:verna,vernon;lavina:ina,vina,viney;lavinia:ina,vina,viney",
    "lavonia:vina,viney,vonnie,wyncha;lavonne:von;lawrence:larry,lawrie,lon,lonny,lorne,lorry",
    "leanne:annie,lea;lecurgus:curg;leilani:lani;lemuel:lem;lena:ellen;lenora:lee,nora;leo:leon",
    "leonard:len,lenny,leo,leon,lineau;leonidas:lee,leon;leonora:nell,nellie,nora",
    "leonore:elenor,honor,nora;leroy:lee,lr,roy;lesley:les;leslie:les;lester:les",
    "letitia:lettice,lettie,tish,titia;levi:lee;levicy:vicy;levone:von;lexi:lex;lib:libby;lidia:lyddy",
    "lil:lilly,lily;liliana:lil,lilly,lily;lillah:lil,lilly,lily,lolly;lillian:lil,lilly,lolly",
    "lilly:lil,lily;lily:lil,lilly;lincoln:link;linda:lindy,lynn;lindsay:lindsey,lindsie,lindsy",
    "lindy:lynn;lionel:leon;lisa:liz;littleberry:berry,lb,little;lizzie:liz;lois:lou,louise;lonzo:lon",
    "lorelei:laurie,lori,lorrie;lorenzo:loren;loretta:etta,lorie,lorrie,retta;lorraine:lorie,lorrie",
    "lotta:lottie;lou:louis,lu;louis:lewis,lou,louie,louise;louisa:eliza,lois,lou",
    "louise:eliza,lois,lou;louvinia:vina,viney,vonnie,wyncha;lucas:luke;lucia:lucius,lucy;lucias:luke",
    "lucille:cille,lou,lu,lucy;lucina:sinah;lucinda:cindy,lou,lu,lucy;lucretia:creasey;lucy:lucinda",
    "luella:ella,lu,lula;luke:lucas;lunetta:nettie;lurana:lura;luther:luke;lydia:lyddy",
    "lyndon:lindy,lynn;mabel:amabel,mehitabel;mac:mc;mack:mac,mc;mackenzie:kenzy,mac,mack",
    "maddison:maddi,maddie;maddy:madeline,madelyn,madge",
    "madeline:lena,maddi,maddie,maddy,madge,madie,magda,maggie,maud;madelyn:maddy,madie",
    "madie:madeline,madelyn;madison:maddy,mattie;maegen:meg;magdalena:lena,maggie",
    "magdelina:lena,madge,magda,maggie;mahala:hallie;makayla:kayla;malachi:mally;malcolm:mac,mal,malc",
    "malinda:lindy;manda:mandy;mandie:amanda;mandy:amanda;manerva:eve,minerva,nerva,nervie",
    "manny:manuel;manoah:noah;manola:nonnie;manuel:emanuel,manny;marcus:marc,mark",
    "margaret:daisy,gretta,madge,maggie,maggy,marge,margery,margie,margy,meg,midge,peg,peggy,polly,rita",
    "margaretta:daisy,gretta,madge,maggie,marge,margery,margie,meg,midge,peg,peggy,rita",
    "margarita:daisy,greta,madge,maggie,maisie,marge,margo,meg,megan,metta,midge,peggie,rita",
    "marge:margaret,margaretta,margery;margie:marjorie;marguerite:peggy;maria:mia,ria",
    "mariah:maria,mary;marian:marianna,marion;marie:mae,mary",
    "marietta:mae,mamie,maria,mariah,marie,marion,mary,maureen,may,mercy,minnie,mitzi,mollie,molly,polly",
    "marilyn:mary;marion:mary;marissa:rissa;marjorie:margie,margy;marni:marnie",
    "marsha:marcia,marcie,mary;martha:marty,mat,mattie,patsy,patty;martin:marty;martina:tina",
    "martine:tine;marv:marvin;marvin:marv;mary:mae,mamie,marie,mitzi,molly,polly;masayuki:masa",
    "mat:mattie;mathew:mat,matt,maty;mathilda:patty,tillie;matilda:matty,maud,tilla,tilly;matt:matty",
    "matthew:matt,mattie,matty,thias,thys;matthews:matt,mattie,matty;matthias:matt,thias,thys",
    "maud:middy;maureen:mary;maurice:morey;mavery:mave;mavine:mave;max:maxie;maximilian:max",
    "maximillian:max;maxine:max;maxwell:max;may:mae;mckenna:ken,kenna,meaka;medora:dora;megan:meg",
    "meghan:meg;mehitabel:hetty,hitty,mabel,mitty;melanie:mellie;melchizedek:dick,zadock",
    "melinda:linda,lindy,lynn,mel,mindy;melissa:lisa,lissa,mel,milly,missy;mellony:mellia;melody:lodi",
    "melvin:mel;melvina:vina;mercedes:merci,mercy,sadie;merv:mervin;mervin:merv;mervyn:merv",
    "micajah:cage;michael:micah,mick,mickey,micky,mike,mikey;micheal:mike,mikey,miky",
    "michele:chelle,mickey,shelley,shellie,shelly;michelle:chelle,mickey,shelley,shellie,shelly,shely",
    "mick:micky;miguel:michael,miggy,miguael,miguaell,miguail,miguaill,miguayl,miguayll,miguell,mike",
    "mike:michael,mick,micky;mildred:milly;millicent:milly,missy;minerva:minnie;minnie:wilhelmina",
    "miranda:mandy,mira,randi,randy;miriam:mimi,mitzi,mitzie;missy:melissa;mitch:mitchell",
    "mitchell:mitch;mitzi:mary,mittie,mitty;mitzie:mittie,mitty;monet:nettie;monica:monna,monnie",
    "monte:monty;monteleon:monte;montesque:monty;montgomery:gum,monty;monty:lamont;morris:morey",
    "mortimer:mort;moses:amos,mose,moss;muriel:mur;myrtle:mert,myrt,myrti;nadine:deedee,nada",
    "nancy:ann,nan,nanny;naomi:omi;napoleon:leon,nap,nappy;natalia:nat,talia;natalie:natty,nettie",
    "natasha:nat,tasha;nathan:nat,nate;nathaniel:nat,nate,nathan,natty,than;nelle:nelly;nellie:nell",
    "nelson:nels;newt:newton;newton:newt;nicholas:claas,claes,nic,nick,nickie,nicky,nico",
    "nichole:cole,nicki,nicky,nikki;nicholette:cole,nichole,nickey,nicki,nicky,nicole,nikki",
    "nicodemus:nic,nick,nickie,nicky,nico;nicolas:nic,nick,nickie,nicky,nico",
    "nicole:cole,nicki,nicky,nikki,nole;nikolas:claes,nic,nick,nickie,nicky,nico;nikole:nikki",
    "nora:nonie;norbert:bert,norby;norbusamte:norbu;norman:norm;nowell:noel",
    "obadiah:diah,dyer,obed,obie;obediah:obie;obedience:beda,beedy,biddie,obed;obie:obediah",
    "octavia:tave,tavia;odell:odo;olive:livia,nollie,ollie;oliver:ollie;olivia:livia,nollie,ollie",
    "ollie:oliver;onicyphorous:cy,cyphorus,one,osaforum,osaforus,syphorous;orilla:ora,rilly",
    "orlando:roland;orphelia:phelia;ossy:ozzy;oswald:ossy,ozzy,waldo;otis:ode,ote;pamela:pam",
    "pandora:dora;parmelia:amelia,melia,milly;parthenia:parsuny,pasoonie,phenie,teeny",
    "patience:pat,patty;patricia:pat,patsy,patti,patty,tricia,trish,trisha",
    "patrick:paddy,pat,pate,patsy,peter;patsy:patty;patty:patricia;paul:polly;paula:lina,polly",
    "paulina:lina,polly;pauline:polly;peggy:peg;pelegrine:perry;penelope:penny;percival:percy",
    "peregrine:perry;permelia:mellie,melly,milly;pernetta:nettie;persephone:seph,sephy;pete:petey",
    "peter:pate,pete;petronella:nellie;pheney:josephine;pheriba:ferbie,pherbia;philadelphia:delphia",
    "philander:fie;philetus:leet,phil;philinda:linda,lindy,lynn;philip:phil,pip",
    "philipina:penie,phoebe,pip;phillip:phil,pip;philly:delphia;philomena:menaalmena;phoebe:fifi",
    "phyllis:phyl;pinckney:pink;pleasant:ples;pocahontas:pokey;posthuma:humey",
    "prescott:pres,scott,scotty;priscilla:cilla,cissy,prissy;providence:provy;prudence:prudy,prue",
    "prudy:prudence;rachael:rach;rachel:rachael,shelly;rafaela:rafa;ramona:mona;randall:randy",
    "randolf:dolph,randy;randolph:dolph,randy;raphael:ralph;ray:raymond;raymond:ray;reba:becca,beck",
    "rebecca:becca,beck,becky,reba;reggie:reg,reginald;regina:gina,reggie",
    "reginald:naldo,reg,reggie,renny;relief:leafa;reuben:rube;reynold:reginald;rhoda:rodie",
    "rhodella:della;rhyna:rhynie;ricardo:rick,ricky;rich:dick,rick",
    "richard:dick,dickie,dickon,dicky,rich,richie,rick,ricky;rick:ricky;ricky:dick,rich",
    "robert:bill,billy,bob,bobby,dob,dobbin,hob,hobkin,rob,robby,rupert",
    "roberta:bert,bertie,birdie,birtie,bobbie,robbie,roby;roberto:rob;robin:rob,robbie",
    "roderick:erick,rickie,rod,roddy;rodger:bobby,hodge,rod,roge,roger;rodney:rod",
    "roger:bobby,hodge,rod,rodger,roge;roland:lanny,orlando,rollo,rolly;ron:ronnie,ronny",
    "ronald:naldo,ron,ronnie,ronny;ronny:ronald;rosa:rose;rosabel:belle,rosa,rose,roz",
    "rosabella:bella,belle,rosa,rose,roz;rosaenn:ann;rosaenna:ann;rosalinda:linda,rosa,rose,roz",
    "rosalyn:linda,rosa,rose,roz;roscoe:ross;rose:rosie;roseann:ann,rose,rosie,roz",
    "roseanna:ann,rose,rosie,roz;roseanne:ann;rosemarie:rose,rosie",
    "rosemary:marie,mary,rose,rosemarie,rosey;rosina:sina;roxane:rox,roxie;roxanna:ann,rose,roxie",
    "roxanne:ann,rose,roxie;rudolph:dolph,olph,rolf,rudy;rudolphus:dolph,olph,rolf,rudy",
    "russell:russ,rusty;ruth:ruthie;ryan:ry;sabrina:brina;safieel:safie;salome:loomie",
    "salvador:sal,sally;sam:sammy;samantha:mantha,sam,sammy;sampson:sam,sammy;samson:sam,sammy",
    "samuel:sam,sammy;samyra:myra,sam,sammy;sandra:cassandra,sandy;sandy:sandra;sanford:sandy",
    "sarah:sadie,sally,sara;sarilla:silla;savannah:anna,savanna,vannie",
    "scott:sceeter,scottie,scotty,squat;sebastian:seb,sebby;selma:anselm;serena:rena;serilla:rilla",
    "seymour:morey,see;shaina:sha,shay;sharon:sha,shay;shaun:shawn;shawn:shaun;sheila:cecilia",
    "sheldon:shelly;shelton:shel,shelly,tony;sheridan:dan,danny,sher",
    "sheryl:cheri,cherie,sher,sheri,sherri,sherry,sherryl;shirley:lee,sherry,shirl",
    "sibbilla:sibbell,sibbie,sybill;sidney:sid,syd;sigfired:sid;sigfrid:sid;sigismund:sig;silas:si",
    "silence:liley;silvester:si,sly,syl,vest,vester;simeon:si,sion;simon:si,sion;smith:smitty",
    "socrates:crate;sofia:sofie,sophie;solomon:sal,salmon,saul,sol,solly,zolly;sondra:dre,sonnie",
    "sophia:sophie;sophronia:frona,fronia,sophia;stacey:staci,stacie,stacy;stacie:stacey,staci,stacy",
    "stacy:staci;stanley:stan;stephan:steve",
    "stephanie:annie,steffi,steffie,steph,stephani,stephany,stephie,stephine,stevie",
    "stephen:steph,steve;steve:stevie;steven:steph,steve,stevie;stuart:stu;sue:susan,susie",
    "sullivan:sully,van;susan:hannah,sue,sukey,susie,suzie;susannah:hannah,sue,sukey,susie",
    "susie:suzie;suzanne:sue,suki,susie;sybill:sibbie;sydney:sid;sylvanus:sly,syl",
    "sylvester:si,sly,sy,syl,vessie,vester,vet;sylvia:syl,sylvie;tabby:tabitha;tabitha:tabby",
    "tamara:tami,tammie,tammy;tamarra:tammy;tammie:tami,tammy;tammy:tami,tammie;tanafra:tanny",
    "tasha:tash,tashie;ted:teddy;temperance:tempy;terence:terry;teresa:terry,tess,tessa,tessie",
    "terri:teri,terrie,terry;terry:terence;tess:teresa,theresa;tessa:teresa,theresa;thad:thaddeus",
    "thaddeus:thad;theo:theodore;theodora:dora;theodore:ted,teddy,theo",
    "theodosia:dosia,theo,theodosius;theophilus:ophi;theotha:otha",
    "theresa:terry,tess,tessa,tessie,thirza,thursa,traci,tracie,tracy;thom:thomas,tom,tommy",
    "thomas:thom,tom,tommy;thomasa:tamzine;tiffany:tiff,tiffy;tilford:tillie;tim:timmy",
    "timothy:tim,timmy;tina:christina;tisha:tish;tobias:bias,toby;tom:thomas,tommy;tony:anthony",
    "tonya:toni;tracey:traci,tracie,tracy;tranquilla:quilla,trannie;travis:trav;trevor:trev",
    "tricia:trish;trish:patricia,trisha;tristan:tris;trix:trixie;trudy:gertrude;tryphena:phena",
    "tyler:ty;unice:eunice,nicie;uriah:riah;ursula:sula,sulie;valentina:felty,val,vallie",
    "valentine:felty;valeri:val,valerie;valeria:val;valerie:val;vanburen:buren;vandalia:vannie",
    "vanessa:essa,nessa,vanna;vernisee:nicey;vernon:vern",
    "veronica:franky,frony,ron,ronie,ronna,ronnie,ronny,vonnie;vic:vicki,vickie,vicky,victor",
    "vicki:vickie,vicky,victoria;victor:vic",
    "victoria:tori,torie,torri,torrie,tory,vic,vicki,vickie,vicky;vijay:vij",
    "vincent:vic,vin,vince,vinnie,vinny;vincenzo:vic,vin,vince,vinnie,vinny",
    "vinson:vin,vince,vinnie,vinny;viola:ola,vi;violet:vi;violetta:lettie",
    "virginia:ginger,ginny,jane,jennie,virgy;vivian:vi,viv;waldo:ossy,ozzy;wallace:wally;wally:walt",
    "walter:wally,walt;washington:wash;webster:webb;wendy:wen;wesley:wes;westley:farmboy,wes,west",
    "weston:wes;wilber:bert,will;wilbur:will,willie,willy;wilda:willie;wilfred:fred,wil,will,willie",
    "wilhelm:wil,willie;wilhelmina:mina,minnie,willie,wilma;will:bill,fred,wilbur,willie",
    "william:bela,bell,bill,billy,wil,will,willie,willy;willie:fred,william;willis:bill,willy",
    "wilma:billiewilhelm,william;wilson:will,willie,willy;winfield:field,win,winny",
    "winifred:freddie,winnet,winnie;winnie:winnifred;winnifred:fred,freddie,freddy,winnie,winny",
    "winny:winnifred;winton:wint;woodrow:drew,wood,woody;yeona:ona,onie;yoshihiko:yoshi;yulan:lan,yul",
    "yvonne:vonna;zach:zack,zak;zachariah:zac,zach,zachy,zack,zak,zakk,zeke",
    "zachary:zac,zach,zachy,zack,zak,zakk,zeke;zachery:zac,zach,zachy,zack,zak,zakk,zeke",
    "zack:zach,zak;zebedee:zeb;zedediah:diah,dyer,zed;zephaniah:zeph",
].join(";");

/**
 * Every direct pair, both directions, as "a|b" keys. Built once at module
 * load (~2,827 pairs -> ~5,654 keys); membership is then one Set lookup per
 * name comparison, which is what lets candidate-sets run this inside its
 * all-pairs scan without a measurable cost.
 */
const PAIR_KEYS: Set<string> = (() => {
  const keys = new Set<string>();
  for (const entry of PACKED_CORPUS.split(";")) {
    const sep = entry.indexOf(":");
    if (sep <= 0) continue;
    const canonical = entry.slice(0, sep);
    for (const nick of entry.slice(sep + 1).split(",")) {
      if (!nick) continue;
      keys.add(`${canonical}|${nick}`);
      keys.add(`${nick}|${canonical}`);
    }
  }
  return keys;
})();

/**
 * Are these two lowercase name tokens a known nickname pair, in either
 * direction? ("bill" ~ "william", "william" ~ "bill".) Exact-equal tokens
 * return false: equality is already handled, and stronger, in partCompat.
 */
export function isNicknamePair(a: string, b: string): boolean {
  if (a === b) return false;
  return PAIR_KEYS.has(`${a}|${b}`);
}
