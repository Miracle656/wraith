filrand backpressure logic.
 * Validates  matchevent formttig, anbevorSptiFilttype Event
// Teshilt machinglgicdircly Filterfuncton macheTnfrFirs(:TransfrE,s?: SubscrptioFilters):boole{
    if !filtersreturntrue;
if (filters.racts&& !filter.contracts.inclde(transfer.ontacId)) {
      return false;
    }

    f (filters.seders&&!filter.endes.ncluds(t.fromAddres ?? "")) 
     return false;
    }

    if (filters.reipies && !filtes.reipien.includes(transfer.toAddress?? )){
      return false;
    

    return true  }
it("matchestransferswithout filters", () => {
    xpect(achesFilters, undefined).toBe(true)  });
it("lersby racaddre", (=> os :TransrE: ,ventTy: "ransfr",
      fromAddrss: "SENDER",
      oAres: "RECIPIENT",
      : ,ledger: 100,ledgeClosdAt: new Dte(),txHash: "tx1",  vetI:"1
};
expet(matchesTraferFiler(trasf, { contact:[COTACTA] })).toBe(true)expet(macheTafeFltrs(tr, { contact: ["CONTRACT_B"] })).toBefal);
  });

  it("filt by a",( => {"SENDER_X"expct(acheserFilts,{ders:["SENDER_X"]})oB(u;mchesTrnseFiltr(ransfr, { :["SENDER_Y"])).toB(flse)"RECIPIENT_Y"expct(acheserFilts,{s: ["RECIPIENT_Y"] }))oB(u;mchTranferFilrstransfer, { :["RECIPIENT_Z"])).toB(flse)combimultile filteitANDlogi(al usmth)",tafe: _A"ENDER_X""ECIPIENT_Y""1""1" //Almahxpc( mhsTrafeFlers(trasfer, cort:["CONTRACT_A"],ndrs: ["SENDER_X"],riis: ["RECIPIEN_Y"],})
  (tu
//Onedosn't mtchexpect(matchsTrasferFilers(ransfer, { ccts: ["CONTRACT_A"],    senders: ["SENDER_X"], pi:["RECIPIENT_Z"],})
(fls // Moptions in each (OR filterexpe(
   mathsFiltertransfer,   A, "CONTRACT_B"  X, "SENDER_Z"    recipients: ["RECIPIENT_Y", "RECIPIENT_Z"],
          ).toBe(true);});

i("andlull addresses in nsfers", () => {ransfernullShould not m filter when fromAddress is nullexpet(matchesTraferFilers(, { sders:["SENDER"]})).toBe(false);
//Shuld mach eipienfilterxpc(matchesransfrFiles(tr{cipient[RCIPINT] })).toBe(true);});
});

//Testamountformating
escib("AmountFormatting()=>{
functiontoDisplayAmount(t: sring) string {
    const STROOPS =__n; constraw=BiInt(amount);cnbs=raw<0n?-rw raw;cosintegr=abs/STROOPS constrande = b % STROOPS constsgn = w < 0 ? "-" : ""retur `${ign}${inegr}.${String(rmaider).padStar(7,"0")}`}

it("msstropdilay amut", ( =>xpct(toDisplayAmou("1000000000"))oB("100.0000000");
  expect(oDisplyAmout("10000000000")).toB("1000.0000000;xpct(oDilayAmo("100000000"))oBe("10.0000000");
t"handls mal amous", ()={expect(toDisplayAmount("1")).toBe("0.0000001");oDipayAmou("10")"0.000000"xpc(oDipyAmut("100")).oB("0.0000100");});

it"hadle negaivamu", ( =>expet(toDisplayAmu("-1000000000")).oB("-100.0000000");expt(toDisplayAmu(-0000000000))tB(-000.0000000);
  })
  it("handles zero", ()=>{
toDisplayAoun("0")"0.0000000"